/**
 * Role-based access control. Permissions are enforced on the server in every
 * route; the frontend only mirrors them to hide unusable controls.
 */

export type CompanyRole = 'owner' | 'marketing_manager' | 'content_writer' | 'designer' | 'viewer';

export const COMPANY_ROLES: CompanyRole[] = [
  'owner',
  'marketing_manager',
  'content_writer',
  'designer',
  'viewer',
];

export const ROLE_PERMISSIONS: Record<CompanyRole, string[]> = {
  owner: [
    'company.view',
    'company.edit',
    'team.view',
    'team.manage',
    'subscription.view',
    'billing.manage',
    'analysis.view',
    'analysis.create',
    'analysis.edit',
    'analysis.review',
    'analysis.approve',
    'content.create',
    'content.review',
    'content.approve',
    'leads.manage',
    'social.manage',
    'reports.view',
  ],
  marketing_manager: [
    'company.view',
    'company.edit',
    'team.view',
    'analysis.view',
    'analysis.create',
    'analysis.edit',
    'analysis.review',
    'content.create',
    'content.review',
    'content.approve',
    'leads.manage',
    'social.manage',
    'reports.view',
  ],
  // Writers and designers can read approved reports only; they cannot edit or
  // approve them unless an explicit permission is granted here.
  content_writer: ['company.view', 'team.view', 'analysis.view_approved', 'content.create', 'reports.view'],
  designer: ['company.view', 'team.view', 'analysis.view_approved', 'content.create', 'reports.view'],
  viewer: ['company.view', 'analysis.view_approved', 'reports.view'],
};

export const isCompanyRole = (value: unknown): value is CompanyRole =>
  typeof value === 'string' && COMPANY_ROLES.includes(value as CompanyRole);

export function can(role: string | undefined, permission: string) {
  if (!role) return false;
  const permissions = ROLE_PERMISSIONS[role as CompanyRole];
  return Boolean(permissions?.includes(permission));
}

/** Permissions that grant full access to draft analyses and their raw pages. */
export const isAnalysisReviewer = (role: string | undefined) =>
  can(role, 'analysis.review') || can(role, 'analysis.approve');
