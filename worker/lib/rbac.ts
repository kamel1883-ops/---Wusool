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
    'content.create',
    'content.review',
    'content.approve',
    'leads.manage',
    'reports.view',
  ],
  marketing_manager: [
    'company.view',
    'company.edit',
    'team.view',
    'content.create',
    'content.review',
    'content.approve',
    'leads.manage',
    'reports.view',
  ],
  content_writer: ['company.view', 'team.view', 'content.create', 'reports.view'],
  designer: ['company.view', 'team.view', 'content.create', 'reports.view'],
  viewer: ['company.view', 'reports.view'],
};

export const isCompanyRole = (value: unknown): value is CompanyRole =>
  typeof value === 'string' && COMPANY_ROLES.includes(value as CompanyRole);

export function can(role: string | undefined, permission: string) {
  if (!role) return false;
  const permissions = ROLE_PERMISSIONS[role as CompanyRole];
  return Boolean(permissions?.includes(permission));
}
