export type UserRole = "admin" | "user";

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): UserRole {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  )
    ? "admin"
    : "user";
}
