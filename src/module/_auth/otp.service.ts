import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { ObjectId } from 'mongodb';
import { getCoreUnified } from '../../configs/core';
import { redisClient } from '../../configs/redis';
import { AppError } from '../../utils/app-error';
import { sha256, revokeAllForUser } from './token-blacklist.service';

/**
 * Forgot/reset password via OTP email (see docs/auth-token-blacklist-otp-design.md §6).
 *
 * Security:
 *  - The OTP-request step's response is ALWAYS generic (anti-enumeration — doesn't reveal whether the email exists).
 *  - Only the HASH of the OTP (sha256) is stored, never plaintext.
 *  - TTL 5 minutes, max 5 attempts, key deleted immediately on success (anti-replay).
 *  - Rate-limit + cooldown per email.
 *  - OTP generated with crypto.randomInt (CSPRNG), NOT Math.random.
 *
 * Single-tenant runtime (backend-tenant-deploy): does NOT use the global MailService/.env.
 * OTP mail is sent via SMTP configured in the tenant's `config-settings` entity (`mail` group) —
 * same as front-form-builder. Missing/disabled config → sendOtpMail throws → forgot-password still
 * returns generic 200 (fire-and-forget), it just fails to send mail (the OTP feature is effectively off).
 */

const OTP_TTL = Number(process.env.OTP_TTL_SECONDS) || 300;
const OTP_LENGTH = Number(process.env.OTP_LENGTH) || 6;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const RL_MAX = Number(process.env.OTP_RATELIMIT_MAX) || 3;
const RL_WINDOW = Number(process.env.OTP_RATELIMIT_WINDOW) || 900;
const RESEND_COOLDOWN = Number(process.env.OTP_RESEND_COOLDOWN) || 60;

const GENERIC_MSG = 'Nếu email tồn tại, mã OTP đã được gửi.';
const INVALID_OTP_MSG = 'OTP không đúng hoặc đã hết hạn.';

interface OtpRecord {
  codeHash: string;
  attempts: number;
  userId: string;
}

export class OtpService {
  private db: any;
  private isInitialized = false;

  private async ensureInitialized() {
    if (!this.isInitialized) {
      this.db = await getCoreUnified().getInstanceDB('mongodb');
      this.isInitialized = true;
    }
  }

  private createError(message: string, statusCode: number): AppError {
    return new AppError({ statusCode, code: `HTTP_${statusCode}`, message, expose: statusCode < 500 });
  }

  private normalizeEmail(email: string): string {
    return String(email || '').trim().toLowerCase();
  }

  private otpKey(emailHash: string) { return `otp:pwd:${emailHash}`; }
  private rlKey(emailHash: string) { return `otp:pwd:rl:${emailHash}`; }
  private cooldownKey(emailHash: string) { return `otp:pwd:cd:${emailHash}`; }

  /** Generate an n-digit OTP using CSPRNG, zero-padded on the left. */
  private genOtp(): string {
    const max = 10 ** OTP_LENGTH;
    return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
  }

  /**
   * Step 1 — request OTP. ALWAYS returns generic 200 whether the email exists or not, or whether it's rate-limited.
   * Rate-limit / cooldown / user-not-found all exit silently (no leak, no mail sent).
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    await this.ensureInitialized();
    const normEmail = this.normalizeEmail(email);
    const emailHash = sha256(normEmail);

    try {
      // Cooldown between 2 sends (anti mail-spam).
      const onCooldown = await redisClient.exists(this.cooldownKey(emailHash));
      if (onCooldown) return { message: GENERIC_MSG };

      // Rate-limit by window.
      const count = await redisClient.incr(this.rlKey(emailHash));
      if (count === 1) await redisClient.expire(this.rlKey(emailHash), RL_WINDOW);
      if (count > RL_MAX) return { message: GENERIC_MSG };

      // Look up the user — still returns generic even if not found (anti-enumeration).
      const user = await this.db.collection('user').findOne({ email: normEmail });
      if (!user) return { message: GENERIC_MSG };

      const otp = this.genOtp();
      const record: OtpRecord = { codeHash: sha256(otp), attempts: 0, userId: user._id.toString() };
      await redisClient.set(this.otpKey(emailHash), JSON.stringify(record), 'EX', OTP_TTL);
      await redisClient.set(this.cooldownKey(emailHash), '1', 'EX', RESEND_COOLDOWN);

      // Fire-and-forget: a mail-send error does NOT block the response (still returns generic).
      this.sendOtpMail(normEmail, otp).catch((err) =>
        console.error('[otp] gửi mail OTP thất bại:', (err as Error)?.message)
      );
    } catch (err) {
      // Redis/DB errors also return generic — doesn't leak system state to the client.
      console.error('[otp] forgotPassword lỗi:', (err as Error)?.message);
    }

    return { message: GENERIC_MSG };
  }

  /**
   * Step 2 — verify OTP + set new password. On success → revoke-all (logs out all devices) +
   * delete the OTP key. Returns `user` so the controller can mint a new token (auto-login).
   */
  async resetPassword(
    email: string,
    otp: string,
    newPassword: string
  ): Promise<{ message: string; user: any }> {
    await this.ensureInitialized();

    if (!newPassword || newPassword.length < 8 || newPassword.length > 72) {
      throw this.createError('Password must be between 8 and 72 characters', 400);
    }

    const normEmail = this.normalizeEmail(email);
    const emailHash = sha256(normEmail);
    const key = this.otpKey(emailHash);

    const raw = await redisClient.get(key);
    if (!raw) throw this.createError(INVALID_OTP_MSG, 400);

    let record: OtpRecord;
    try {
      record = JSON.parse(raw);
    } catch {
      await redisClient.del(key);
      throw this.createError(INVALID_OTP_MSG, 400);
    }

    // Out of attempts → delete the key, forcing a new request.
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await redisClient.del(key);
      throw this.createError(INVALID_OTP_MSG, 400);
    }

    // Compare OTP hash. Wrong → increment attempts (keep the same TTL), then 400.
    if (sha256(String(otp || '')) !== record.codeHash) {
      record.attempts += 1;
      await redisClient.set(key, JSON.stringify(record), 'KEEPTTL');
      throw this.createError(INVALID_OTP_MSG, 400);
    }

    // OTP correct → set new password.
    let _id: ObjectId;
    try {
      _id = new ObjectId(record.userId);
    } catch {
      await redisClient.del(key);
      throw this.createError(INVALID_OTP_MSG, 400);
    }

    const user = await this.db.collection('user').findOne({ _id });
    if (!user) {
      await redisClient.del(key);
      throw this.createError(INVALID_OTP_MSG, 400);
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.db.collection('user').updateOne({ _id }, { $set: { password: hashed } });

    // Revoke-all BEFORE the controller mints a new token → new token's iat >= revokedAt.
    await revokeAllForUser(record.userId);
    await this.db.collection('user_token').deleteMany({ user_id: record.userId });

    // Anti-replay: delete the OTP immediately on success.
    await redisClient.del(key);

    return { message: 'Đặt lại mật khẩu thành công.', user };
  }

  /**
   * Build the SMTP transporter from the tenant's `config-settings` entity (`mail` group).
   * NO .env fallback: missing config / is_active off / missing host|user|password → throws
   * (the fire-and-forget caller catches the error, it just fails to send mail). Logic kept in
   * sync with front-form-builder.resolveMailer (forces `secure` based on port to avoid mixing up 587+secure).
   */
  private async resolveTransporter(): Promise<{ transporter: nodemailer.Transporter; from: string }> {
    const doc: any = await this.db.collection('config-settings').findOne({});
    const mail = doc?.mail;
    if (!mail || mail.is_active === false) {
      throw new Error('Mail chưa cấu hình trong config-settings (nhóm mail)');
    }
    if (!mail.host || !mail.user || !mail.mail_pass) {
      throw new Error('Config mail thiếu host|user|mail_pass');
    }
    const port = Number(mail.port) || 587;
    let secure = mail.secure ?? port === 465;
    if (secure && port !== 465) secure = false;
    const transporter = nodemailer.createTransport({
      host: mail.host,
      port,
      secure,
      requireTLS: !secure,
      auth: { user: mail.user, pass: mail.mail_pass },
    });
    let from: string;
    if (mail.from && mail.from.includes('<')) {
      from = mail.from;
    } else {
      const fromEmail = mail.from || mail.user;
      from = mail.from_name ? `"${mail.from_name}" <${fromEmail}>` : fromEmail;
    }
    return { transporter, from };
  }

  /** Send the OTP email via the tenant's SMTP (config-settings.mail). Minimal inline HTML. */
  private async sendOtpMail(email: string, otp: string): Promise<void> {
    const minutes = Math.round(OTP_TTL / 60);
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222">
        <h2 style="margin:0 0 12px">Mã đặt lại mật khẩu</h2>
        <p>Mã OTP của bạn là:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:16px 0">${otp}</p>
        <p>Mã có hiệu lực trong <b>${minutes} phút</b>. Không chia sẻ mã này cho bất kỳ ai.</p>
        <p style="color:#888;font-size:13px;margin-top:24px">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>
      </div>`;
    const { transporter, from } = await this.resolveTransporter();
    await transporter.sendMail({ from, to: email, subject: 'Mã đặt lại mật khẩu', html });
  }
}
