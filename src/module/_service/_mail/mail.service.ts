import { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import { Attachment } from "nodemailer/lib/mailer";
import { MailOptions } from "nodemailer/lib/sendmail-transport";

interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  ssl: boolean;
  tls: boolean;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

interface SendMail {
  subject: string
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  html: string;
  attachments?: Attachment | Attachment[];
  from?: string;
  replyTo?: string;
  replyToName?: string;
  replyToEmail?: string;
}

class MailService {
  private mailConfig: MailConfig;
  private transporter: Transporter;
  constructor(mailConfig: MailConfig) {
    this.mailConfig = mailConfig;
    this.transporter = nodemailer.createTransport({
      host: this.mailConfig.host,
      port: this.mailConfig.port,
      auth: {
        user: this.mailConfig.user,
        pass: this.mailConfig.password,
      },
    });
  }

  async sendMail(sendMail: SendMail) {
    const mailOptions: MailOptions = {
      from: sendMail.from || this.mailConfig.user,
      to: sendMail.to,
      cc: sendMail.cc,
      bcc: sendMail.bcc,
      html: sendMail.html,
      attachments: Array.isArray(sendMail.attachments) ? sendMail.attachments.filter(attachment => attachment !== undefined) as Attachment[] : [sendMail.attachments as Attachment],
      subject: sendMail.subject,
      replyTo: sendMail.replyTo,
    };
    await this.transporter.sendMail(mailOptions);
  }
}
  
export default MailService;