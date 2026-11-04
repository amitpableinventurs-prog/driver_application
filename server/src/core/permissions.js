export const PERMISSIONS = [
  'dashboard', 'bookings', 'drivers', 'customers', 'finance', 'pricing',
  'coupons', 'support', 'content', 'settings', 'admins', 'audit',
];

export const ROLES = {
  super_admin: { label: 'Super Admin', permissions: PERMISSIONS },
  operations: { label: 'Operations', permissions: ['dashboard', 'bookings', 'drivers', 'customers', 'pricing', 'support'] },
  finance: { label: 'Finance', permissions: ['dashboard', 'finance', 'coupons'] },
  support: { label: 'Support', permissions: ['dashboard', 'bookings', 'customers', 'support'] },
  content: { label: 'Content', permissions: ['dashboard', 'content', 'coupons'] },
};
