-- CreateTable
CREATE TABLE "n3_zones" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "start_page" INTEGER NOT NULL,
    "end_page" INTEGER NOT NULL,
    "approx_items" INTEGER NOT NULL,
    "verification_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "n3_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_zone_correspondences" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "correspondence_type" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "n3_zone_correspondences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_line_items" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "source" TEXT NOT NULL,
    "source_line_number" INTEGER NOT NULL,
    "page_number" INTEGER NOT NULL,
    "raw_description" TEXT NOT NULL,
    "normalized_description" TEXT NOT NULL,
    "description_tokens" TEXT[],
    "trade" TEXT,
    "action" TEXT,
    "material" TEXT,
    "object" TEXT,
    "item_code" TEXT,
    "raw_quantity" TEXT,
    "normalized_quantity" DECIMAL(14,4),
    "raw_unit" TEXT,
    "normalized_unit" TEXT,
    "remove_amount" DECIMAL(12,2),
    "replace_amount" DECIMAL(12,2),
    "reset_amount" DECIMAL(12,2),
    "tax_amount" DECIMAL(12,2),
    "op_amount" DECIMAL(12,2),
    "total_amount" DECIMAL(12,2),
    "unit_price" DECIMAL(12,4),
    "special_flags" TEXT[],
    "extraction_confidence" DECIMAL(4,3) NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_candidate_edges" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "source_item_id" TEXT NOT NULL,
    "target_item_id" TEXT NOT NULL,
    "retrieval_sources" TEXT[],
    "boosts_json" JSONB NOT NULL,
    "features_json" JSONB NOT NULL,
    "raw_score" DECIMAL(6,4) NOT NULL,
    "final_score" DECIMAL(6,4) NOT NULL,
    "is_rejected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_candidate_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_match_components" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "source_item_ids" TEXT[],
    "target_item_ids" TEXT[],
    "size" TEXT NOT NULL,
    "is_ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_match_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_match_decisions" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "component_id" TEXT,
    "top_edge_id" TEXT,
    "decision_type" TEXT NOT NULL,
    "your_item_ids" TEXT[],
    "adjuster_item_ids" TEXT[],
    "final_score" DECIMAL(6,4) NOT NULL,
    "decided_by" TEXT NOT NULL,
    "group_match_score" DECIMAL(6,4),
    "llm_reasoning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_match_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_llm_calls" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "estimated_cost_usd" DECIMAL(10,6) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n3_extraction_warnings" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "warning_type" TEXT NOT NULL,
    "page_number" INTEGER,
    "line_item_id" TEXT,
    "zone_id" TEXT,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "n3_extraction_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_YourZoneCorrespondences" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_YourZoneCorrespondences_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_AdjusterZoneCorrespondences" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AdjusterZoneCorrespondences_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ComponentEdges" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ComponentEdges_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "idx_n3_zones_comparison_source" ON "n3_zones"("comparison_id", "source");

-- CreateIndex
CREATE INDEX "idx_n3_zone_correspondences_comparison" ON "n3_zone_correspondences"("comparison_id");

-- CreateIndex
CREATE INDEX "idx_n3_line_items_comparison_source" ON "n3_line_items"("comparison_id", "source");

-- CreateIndex
CREATE INDEX "idx_n3_line_items_comparison_total" ON "n3_line_items"("comparison_id", "total_amount");

-- CreateIndex
CREATE INDEX "idx_n3_candidate_edges_score" ON "n3_candidate_edges"("comparison_id", "final_score");

-- CreateIndex
CREATE INDEX "idx_n3_candidate_edges_rejected" ON "n3_candidate_edges"("comparison_id", "is_rejected");

-- CreateIndex
CREATE UNIQUE INDEX "uq_n3_candidate_edge_pair" ON "n3_candidate_edges"("source_item_id", "target_item_id");

-- CreateIndex
CREATE INDEX "idx_n3_match_components_comparison" ON "n3_match_components"("comparison_id");

-- CreateIndex
CREATE INDEX "idx_n3_match_decisions_type" ON "n3_match_decisions"("comparison_id", "decision_type");

-- CreateIndex
CREATE INDEX "idx_n3_llm_calls_comparison_created" ON "n3_llm_calls"("comparison_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_n3_extraction_warnings_comparison_source" ON "n3_extraction_warnings"("comparison_id", "source");

-- CreateIndex
CREATE INDEX "_YourZoneCorrespondences_B_index" ON "_YourZoneCorrespondences"("B");

-- CreateIndex
CREATE INDEX "_AdjusterZoneCorrespondences_B_index" ON "_AdjusterZoneCorrespondences"("B");

-- CreateIndex
CREATE INDEX "_ComponentEdges_B_index" ON "_ComponentEdges"("B");

-- AddForeignKey
ALTER TABLE "n3_zones" ADD CONSTRAINT "n3_zones_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_zone_correspondences" ADD CONSTRAINT "n3_zone_correspondences_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_line_items" ADD CONSTRAINT "n3_line_items_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_line_items" ADD CONSTRAINT "n3_line_items_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "n3_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_candidate_edges" ADD CONSTRAINT "n3_candidate_edges_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_candidate_edges" ADD CONSTRAINT "n3_candidate_edges_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "n3_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_candidate_edges" ADD CONSTRAINT "n3_candidate_edges_target_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "n3_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_match_components" ADD CONSTRAINT "n3_match_components_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_match_decisions" ADD CONSTRAINT "n3_match_decisions_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_match_decisions" ADD CONSTRAINT "n3_match_decisions_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "n3_match_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_match_decisions" ADD CONSTRAINT "n3_match_decisions_top_edge_id_fkey" FOREIGN KEY ("top_edge_id") REFERENCES "n3_candidate_edges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_llm_calls" ADD CONSTRAINT "n3_llm_calls_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_extraction_warnings" ADD CONSTRAINT "n3_extraction_warnings_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_extraction_warnings" ADD CONSTRAINT "n3_extraction_warnings_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "n3_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "n3_extraction_warnings" ADD CONSTRAINT "n3_extraction_warnings_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "n3_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_YourZoneCorrespondences" ADD CONSTRAINT "_YourZoneCorrespondences_A_fkey" FOREIGN KEY ("A") REFERENCES "n3_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_YourZoneCorrespondences" ADD CONSTRAINT "_YourZoneCorrespondences_B_fkey" FOREIGN KEY ("B") REFERENCES "n3_zone_correspondences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AdjusterZoneCorrespondences" ADD CONSTRAINT "_AdjusterZoneCorrespondences_A_fkey" FOREIGN KEY ("A") REFERENCES "n3_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AdjusterZoneCorrespondences" ADD CONSTRAINT "_AdjusterZoneCorrespondences_B_fkey" FOREIGN KEY ("B") REFERENCES "n3_zone_correspondences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ComponentEdges" ADD CONSTRAINT "_ComponentEdges_A_fkey" FOREIGN KEY ("A") REFERENCES "n3_candidate_edges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ComponentEdges" ADD CONSTRAINT "_ComponentEdges_B_fkey" FOREIGN KEY ("B") REFERENCES "n3_match_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;
