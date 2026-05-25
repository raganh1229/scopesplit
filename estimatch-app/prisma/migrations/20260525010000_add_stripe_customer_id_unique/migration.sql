-- AddUniqueConstraint: stripe_customer_id on users
-- Enables prisma.user.findUnique({ where: { stripeCustomerId } }) in the
-- Stripe webhook handler instead of findFirst, making the intent and
-- uniqueness guarantee explicit.
-- NULL values are allowed (no customer yet); PostgreSQL permits multiple
-- NULLs under a UNIQUE constraint.
ALTER TABLE "users" ADD CONSTRAINT "users_stripe_customer_id_key" UNIQUE ("stripe_customer_id");
