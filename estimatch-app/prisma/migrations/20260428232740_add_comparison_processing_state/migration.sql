-- CreateTable
CREATE TABLE "comparison_processing_state" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comparison_processing_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comparison_processing_state_comparison_id_key" ON "comparison_processing_state"("comparison_id");

-- AddForeignKey
ALTER TABLE "comparison_processing_state" ADD CONSTRAINT "comparison_processing_state_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
