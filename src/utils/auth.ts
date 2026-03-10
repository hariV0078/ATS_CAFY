/**
 * Utility to identify administrative users.
 * For now, we use a simple email-based check.
 */

const ADMIN_EMAILS = [
    'shamitest786@gmail.com', // Primary Admin
    // Add other admin emails here
];

export function isAdmin(email: string | undefined): boolean {
    if (!email) return false;
    return ADMIN_EMAILS.includes(email.toLowerCase());
}
