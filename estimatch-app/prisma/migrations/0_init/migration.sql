-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "subscription_tier" AS ENUM ('STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'CANCELED', 'PAST_DUE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "comparison_status" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "match_status" AS ENUM ('MATCH', 'MODIFIED', 'MISSING_FROM_ADJUSTER', 'ADDED_BY_ADJUSTER', 'GROUPED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_number" TEXT,
    "full_name" TEXT,
    "email_opt_in" TEXT,
    "email_opt_in_prompt_dismissed_at" TIMESTAMP(3),
    "company_name" TEXT,
    "stripe_customer_id" TEXT,
    "subscription_tier" "subscription_tier",
    "subscription_status" "subscription_status",
    "pending_tier_downgrade" "subscription_tier",
    "pending_tier_effective_at" TIMESTAMP(3),
    "has_used_trial" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "subscription_ends_at" TIMESTAMP(3),
    "comparisons_used_this_period" INTEGER NOT NULL DEFAULT 0,
    "addon_comparisons_this_period" INTEGER NOT NULL DEFAULT 0,
    "llm_edits_used_this_period" INTEGER NOT NULL DEFAULT 0,
    "executive_summaries_used_this_period" INTEGER NOT NULL DEFAULT 0,
    "period_reset_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_purchases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_session_id" TEXT NOT NULL,
    "addon_key" TEXT NOT NULL,
    "comparisons_granted" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addon_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_cancellation_feedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "subscription_tier" "subscription_tier",
    "feedback_text" TEXT,
    "scheduled_end_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_cancellation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparisons" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "insured_name" TEXT,
    "claim_number" TEXT,
    "property_address" TEXT,
    "your_estimate_filename" TEXT NOT NULL,
    "your_estimate_storage_path" TEXT NOT NULL,
    "your_estimate_total" DECIMAL(12,2),
    "adjuster_estimate_filename" TEXT NOT NULL,
    "adjuster_estimate_storage_path" TEXT NOT NULL,
    "adjuster_estimate_total" DECIMAL(12,2),
    "total_gap" DECIMAL(12,2),
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "modified_count" INTEGER NOT NULL DEFAULT 0,
    "missing_count" INTEGER NOT NULL DEFAULT 0,
    "added_count" INTEGER NOT NULL DEFAULT 0,
    "status" "comparison_status" NOT NULL DEFAULT 'PROCESSING',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_items" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "match_status" "match_status" NOT NULL,
    "zone_yours" TEXT,
    "zone_adjuster" TEXT,
    "zone_canonical" TEXT,
    "zone_confidence" INTEGER,
    "description_yours" TEXT,
    "description_adjuster" TEXT,
    "qty_yours" TEXT,
    "qty_adjuster" TEXT,
    "remove_yours" DECIMAL(12,2),
    "remove_adjuster" DECIMAL(12,2),
    "replace_yours" DECIMAL(12,2),
    "replace_adjuster" DECIMAL(12,2),
    "reset_yours" DECIMAL(12,2),
    "reset_adjuster" DECIMAL(12,2),
    "tax_yours" DECIMAL(12,2),
    "tax_adjuster" DECIMAL(12,2),
    "op_yours" DECIMAL(12,2),
    "op_adjuster" DECIMAL(12,2),
    "total_yours" DECIMAL(12,2),
    "total_adjuster" DECIMAL(12,2),
    "diff_amount" DECIMAL(12,2),
    "category" TEXT,
    "sort_order" INTEGER NOT NULL,
    "group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_versions" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Initial',
    "edit_prompt" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_version_line_items" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "original_line_item_id" TEXT,
    "match_status" "match_status" NOT NULL,
    "zone_yours" TEXT,
    "zone_adjuster" TEXT,
    "zone_canonical" TEXT,
    "zone_confidence" INTEGER,
    "description_yours" TEXT,
    "description_adjuster" TEXT,
    "qty_yours" TEXT,
    "qty_adjuster" TEXT,
    "remove_yours" DECIMAL(12,2),
    "remove_adjuster" DECIMAL(12,2),
    "replace_yours" DECIMAL(12,2),
    "replace_adjuster" DECIMAL(12,2),
    "reset_yours" DECIMAL(12,2),
    "reset_adjuster" DECIMAL(12,2),
    "tax_yours" DECIMAL(12,2),
    "tax_adjuster" DECIMAL(12,2),
    "op_yours" DECIMAL(12,2),
    "op_adjuster" DECIMAL(12,2),
    "total_yours" DECIMAL(12,2),
    "total_adjuster" DECIMAL(12,2),
    "diff_amount" DECIMAL(12,2),
    "category" TEXT,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "comparison_version_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_notes" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "line_item_id" TEXT,
    "user_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comparison_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "addon_purchases_stripe_session_id_key" ON "addon_purchases"("stripe_session_id");

-- CreateIndex
CREATE INDEX "idx_addon_purchases_user_created_at" ON "addon_purchases"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_cancel_feedback_user_created_at" ON "subscription_cancellation_feedback"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_cancel_feedback_stripe_subscription_id" ON "subscription_cancellation_feedback"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "idx_comparison_version_active" ON "comparison_versions"("comparison_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_comparison_version_number" ON "comparison_versions"("comparison_id", "version_number");

-- CreateIndex
CREATE INDEX "idx_version_line_items_sort" ON "comparison_version_line_items"("version_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_comparison_notes_comparison_created" ON "comparison_notes"("comparison_id", "created_at");

-- AddForeignKey
ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_cancellation_feedback" ADD CONSTRAINT "subscription_cancellation_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_versions" ADD CONSTRAINT "comparison_versions_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_version_line_items" ADD CONSTRAINT "comparison_version_line_items_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "comparison_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_notes" ADD CONSTRAINT "comparison_notes_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_notes" ADD CONSTRAINT "comparison_notes_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_notes" ADD CONSTRAINT "comparison_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
