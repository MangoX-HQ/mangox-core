/**
 * Core V2 - Approval Process Plugin
 * Handles workflow approval/status transitions for content
 *
 * Status values:
 * - "-1": Draft
 * - "-2": Rejected
 * - "-3": Scheduled (publish_start in future)
 * - "0": Expired (publish_end in past)
 * - "1": Published
 * - "2"+: Custom approval steps
 */

import { definePlugin, PluginDefinition, PluginContext } from '../plugin-manager';
import { IntermediateQuery, isSingleData, FieldCondition, FilterGroup } from '../../query/intermediate';
import { AuthorizationError, ValidationError, ErrorCodes } from '../../errors';

/** reason only exists together with status = "-2" (Reject); other statuses → reason is removed (invariant 3). */
function nullifyReasonIfNotReject(data: Record<string, unknown>): void {
  if (data.status_approve !== '-2') data.reason = null;
}

// ============================================================================
// APPROVAL OPERATIONS INTERFACE
// ============================================================================

/**
 * Rule definition for approval workflow
 */
export interface ApprovalRule {
  _id?: string;
  code: string;
  name?: string;
  next_status?: string[];
  custom_field?: Array<{
    field?: string;
    fields?: string;
    [key: string]: unknown;
  }>;
}

/**
 * Permission with rules
 */
export interface ApprovalPermission {
  role_name: string;
  permission: Array<{
    action: string;
    [key: string]: unknown;
  }>;
  rule?: string[];
}

/**
 * Interface for approval database operations
 */
export interface IApprovalOperations {
  /**
   * Get permissions for a collection and roles
   */
  getPermissions(collection: string, roles: string[]): Promise<ApprovalPermission[]>;

  /**
   * Get rules by codes
   */
  getRulesByCodes(codes: string[]): Promise<ApprovalRule[]>;

  /**
   * Get original document by ID
   */
  getOriginalDocument(collection: string, id: string): Promise<Record<string, unknown> | null>;

  /**
   * Check if entity has approval process enabled
   */
  isApprovalEnabled(collection: string): Promise<boolean>;

  /**
   * Check if entity is public (public_entity = true)
   */
  isPublicEntity(collection: string): Promise<boolean>;
}

// Global approval operations instance
let approvalOperations: IApprovalOperations | null = null;

/**
 * Set the approval operations implementation
 */
export function setApprovalOperations(ops: IApprovalOperations): void {
  approvalOperations = ops;
}

/**
 * Get the approval operations implementation
 */
export function getApprovalOperations(): IApprovalOperations | null {
  return approvalOperations;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get current time with timezone offset (UTC+7)
 */
function getCurrentTimeWithOffset(): Date {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

/**
 * Check if user can edit at current step of approval process
 */
function canEditOnCurrentStep(
  originalData: Record<string, unknown> | null,
  rules: ApprovalRule[]
): boolean {
  // Allow editing if no original data (new record)
  if (!originalData?.status_approve) {
    return true;
  }

  // Check if user's role has permission for current status
  for (const rule of rules || []) {
    if (rule && rule.code === originalData.status_approve) {
      return true;
    }
  }

  return false;
}

/**
 * Validate status transition based on approval rules
 */
function isValidNextStatus(rules: ApprovalRule[], nextStatus: string): boolean {
  // Allow draft (-1) and rejected (-2) without specific rules
  if ((!rules || rules.length === 0) && (nextStatus === '-1' || nextStatus === '2')) {
    return true;
  }

  for (const rule of rules) {
    if (rule?.next_status?.includes(nextStatus)) {
      return true;
    }
  }

  return false;
}

/**
 * Adjust status based on publish dates
 */
function adjustStatusByPublishDates(
  status: string,
  publishStart: string | Date | null | undefined,
  publishEnd: string | Date | null | undefined
): string {
  if (status !== '1') {
    return status;
  }

  const now = getCurrentTimeWithOffset();

  if (publishEnd) {
    const end = new Date(publishEnd);
    if (!isNaN(end.getTime()) && end <= now) {
      return '0'; // Expired
    }
  }

  if (publishStart) {
    const start = new Date(publishStart);
    if (!isNaN(start.getTime()) && start > now) {
      return '-3'; // Scheduled
    }
  }

  return status;
}

/**
 * READ filter: only shows posts whose status the role is allowed to view.
 * - admin/super_admin → no filter (sees everything).
 * - role with a rule → status_approve IN [role's rule-codes] + '1' (published).
 * - guest / no rule → only '1' (published/public).
 * Injects a securityFilter on `status_approve` (ANDed into the query).
 */
async function applyReadFilter(
  query: IntermediateQuery
): Promise<void> {
  if (!approvalOperations) return;
  const collection = query.collection;
  if (!(await approvalOperations.isApprovalEnabled(collection))) return;

  // public_entity:true → entity is fully public → no filter (every user sees everything).
  if (await approvalOperations.isPublicEntity(collection)) return;

  // user comes from query.metadata.user (UserContext) — same as the locale/history/soft-delete plugin.
  const userRolesRead = (query.metadata?.user?.roles as string[] | undefined) || [];
  // Not logged in → treated as role 'guest'.
  const roles = userRolesRead.length ? userRolesRead : ['guest'];
  if (roles.includes('admin') || roles.includes('super_admin')) return; // admin sees everything

  // Derive the VIEWABLE status FROM the rule: a role holding code X → can view X + the next_status of rule X.
  const permissions = await approvalOperations.getPermissions(collection, roles);
  const ruleCodes = Array.from(new Set(permissions.flatMap((p) => p.rule || [])));

  let visible: string[];
  if (!ruleCodes.length) {
    visible = ['1']; // no rule (guest / not granted) → only published
  } else {
    const rules = await approvalOperations.getRulesByCodes(ruleCodes);
    const visibleSet = new Set<string>();
    for (const r of rules as any[]) {
      if (r?.code != null) visibleSet.add(String(r.code));
      for (const s of r?.next_status || []) visibleSet.add(String(s));
    }
    visible = visibleSet.size ? Array.from(visibleSet) : ['1'];
  }

  const statusCond: FieldCondition = {
    field: 'status_approve',
    operator: visible.length === 1 ? 'eq' : 'in',
    value: visible.length === 1 ? visible[0] : visible,
  };

  // Logged-in user → sees posts at an allowed status OR posts created by THEMSELVES (created_by).
  // Uses securityFilterGroups (OR-group, cannot be bypassed) — ANDed with the FE filter.
  const userId = query.metadata?.user?.user_id as string | undefined;
  if (userId && userId !== 'anonymous') {
    query.securityFilterGroups = query.securityFilterGroups || [];
    query.securityFilterGroups.push({
      operator: 'or',
      conditions: [statusCond, { field: 'created_by', operator: 'eq', value: userId }],
    });
  } else {
    // guest → status only (no posts of their own)
    query.securityFilters = query.securityFilters || [];
    query.securityFilters.push(statusCond);
  }
}

// ============================================================================
// PLUGIN DEFINITION
// ============================================================================

/**
 * Approval Process plugin - handles status transitions and workflow
 *
 * Entity config:
 * - use_approval_process: true/false - Enable/disable plugin
 */
export const approvalProcessPlugin: PluginDefinition = definePlugin('use_approval_process', {
  description: 'Handles approval workflow and status transitions',
  phases: ['before'],
  priority: 5, // Run early, before other data transformations
  enabled: true,

  before: async (query: IntermediateQuery, context: PluginContext): Promise<void> => {
    // READ: filter status_approve by role (guest only sees published).
    if (query.type === 'read') {
      await applyReadFilter(query);
      return;
    }

    // Only handle single data operations for insert/update
    if (!isSingleData(query.data)) return;
    if (query.type !== 'insert' && query.type !== 'update') return;

    const data = query.data;
    // user comes from query.metadata.user (UserContext) — same as the locale/history/soft-delete plugin.
    const userRoles = (query.metadata?.user?.roles as string[] | undefined) || [];
    const collection = query.collection;
    const id = query.metadata?.hints?.id as string | undefined;

    if (!approvalOperations) {
      console.warn('[ApprovalPlugin] No approval operations configured');
      return;
    }

    // Check if entity is public - auto set status = 1
    const isPublic = await approvalOperations.isPublicEntity(collection);
    if (isPublic) {
      data.status_approve = '1';
      nullifyReasonIfNotReject(data);
      return;
    }

    // Skip for admin users - they have full control
    if (userRoles.includes('admin')) {
      // Ensure status exists for admin
      if (!data.status_approve) {
        data.status_approve = '1';
      } else {
        data.status_approve = String(data.status_approve);
      }

      // Adjust based on publish dates (applies to admin TOO — invariant 5)
      data.status_approve = adjustStatusByPublishDates(
        data.status_approve as string,
        data.publish_start as string | undefined,
        data.publish_end as string | undefined
      );
      nullifyReasonIfNotReject(data);
      return;
    }

    // Check if approval is enabled for this entity
    const isEnabled = await approvalOperations.isApprovalEnabled(collection);
    if (!isEnabled) {
      return;
    }

    // Convert status to string
    if (data.status_approve !== undefined && data.status_approve !== null) {
      data.status_approve = String(data.status_approve);
    }

    // Get original document for updates
    let originalData: Record<string, unknown> | null = null;
    if (id) {
      originalData = await approvalOperations.getOriginalDocument(collection, id);
      if (!originalData) {
        originalData = await approvalOperations.getOriginalDocument('post-type-content', id);
      }
    }

    // Preserve publish dates from original if not provided
    if (originalData) {
      data.publish_start = data.publish_start || originalData.publish_start;
      data.publish_end = data.publish_end || originalData.publish_end;
    }

    const method = query.type === 'insert' ? 'POST' : 'PUT';

    // Step 4. Initial state (only when creating new, no original record)
    if (!originalData) {
      if (!data.status_approve) {
        data.status_approve = '-1'; // Default draft status
      } else if (data.status_approve !== '-1' && data.status_approve !== '2') {
        throw new ValidationError(
          ErrorCodes.VALIDATION_FAILED,
          'Initial status must be Draft (-1) or first status (2)'
        );
      }
    }

    // Simplified permission: role → rule applies to the ENTIRE resource within the tenant
    // (not per resource/method). Takes the UNION of rule-codes across all roles the user has.
    const permissions = await approvalOperations.getPermissions(collection, userRoles);
    const ruleCodes = Array.from(new Set(permissions.flatMap((p) => p.rule || [])));

    // Step 3. No rule-code at all, and not creating a draft/submitting for approval for the first time (-1/2) → 403.
    const targetStatus = String(data.status_approve);
    if (ruleCodes.length === 0 && targetStatus !== '-1' && targetStatus !== '2') {
      throw new AuthorizationError(
        ErrorCodes.AUTH_ACCESS_DENIED,
        `Permission denied for ${method} ${collection}`
      );
    }

    const rules = ruleCodes.length ? await approvalOperations.getRulesByCodes(ruleCodes) : [];

    // Step 5. Whether it can be edited at the current step
    if (!canEditOnCurrentStep(originalData, rules)) {
      throw new AuthorizationError(
        ErrorCodes.AUTH_ACCESS_DENIED,
        `User cannot edit at current step (status: ${originalData?.status_approve})`
      );
    }

    // Step 6. Valid status transition
    if (!isValidNextStatus(rules, data.status_approve as string)) {
      throw new ValidationError(
        ErrorCodes.VALIDATION_FAILED,
        `Invalid status transition from ${originalData?.status_approve} to ${data.status_approve}`
      );
    }

    // Step 7. Time window (only when the target status = "1")
    data.status_approve = adjustStatusByPublishDates(
      data.status_approve as string,
      data.publish_start as string | undefined,
      data.publish_end as string | undefined
    );

    // reason only exists together with status = "-2"
    nullifyReasonIfNotReject(data);

    // Step 8. Finalize the data to write: Draft/Reject or POST → write full; otherwise (still in the
    // approval flow) → only write { status_approve } + reason (if present). The approver doesn't edit the content.
    const isFullWrite =
      query.type === 'insert' ||
      !originalData ||
      originalData.status_approve === '-1' ||
      originalData.status_approve === '-2';

    if (!isFullWrite) {
      const allowedFields = ['status_approve', 'reason'];
      Object.keys(data).forEach((key) => {
        if (!allowedFields.includes(key)) delete data[key];
      });
    }
  },
});

export default approvalProcessPlugin;
