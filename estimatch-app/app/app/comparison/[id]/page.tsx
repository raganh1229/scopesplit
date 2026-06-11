'use client';

import { useState, useMemo, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import NotesPanel from '@/components/app/NotesPanel';
import type { NoteLineItemContext, Note } from '@/components/app/NotesPanel';
import ZoneReview from '@/components/app/ZoneReview';
import type { ReviewZone } from '@/components/app/ZoneReview';
import MatchReview from '@/components/app/MatchReview';
import type { MatchPair } from '@/components/app/MatchReview';
import LineItemReview from '@/components/app/LineItemReview';
import type { LineItemZoneRow } from '@/components/app/LineItemReview';
import { markdownToHtml } from '@/lib/markdown-to-html';
import styles from './page.module.css';
import npStyles from '@/components/app/NotesPanel.module.css';

/* ── Mock data (mirrors mock-estimate-data.js) ── */
interface LineItem {
  description: string;
  qty: string;
  remove: number;
  replace: number;
  tax: number;
  op: number;
  total: number;
  totalDisplay?: string;
}
interface Row {
  id?: string;
  originalLineItemId?: string | null;
  status: 'match' | 'match_unverified' | 'modified' | 'missing' | 'added';
  category: string;
  your: LineItem | null;
  adjuster: LineItem | null;
}
interface Zone {
  id: string;
  canonicalName: string;
  yourName: string | null;
  adjusterName: string | null;
  confidence: number | null;
  items: Row[];
}

type ApiComparisonDetail = {
  id: string;
  name: string | null;
  status: 'PROCESSING' | 'AWAITING_ZONE_REVIEW' | 'AWAITING_MATCH_REVIEW' | 'AWAITING_LINE_ITEM_REVIEW' | 'COMPLETED' | 'FAILED';
  errorMessage: string | null;
  createdAt: string;
  yourEstimateFilename: string;
  adjusterEstimateFilename: string;
  yourEstimateTotal: number | null;
  adjusterEstimateTotal: number | null;
  totalGap: number | null;
  matchCount: number;
  modifiedCount: number;
  missingCount: number;
  addedCount: number;
};

const mockZones: Zone[] = [
  {
    id: 'general', canonicalName: 'General Items', yourName: 'General Items', adjusterName: 'General', confidence: 92,
    items: [
      { status: 'match', category: 'debris-removal', your: { description: 'Dumpster load - Approx. 30 yards, 5-7 tons of debris', qty: '1.00 EA', remove: 0, replace: 877.20, tax: 0, op: 0, total: 877.20 }, adjuster: { description: 'Dumpster load - Approx. 20 yards, 4 tons of debris', qty: '1.00 EA', remove: 0, replace: 881.17, tax: 0, op: 0, total: 881.17 } },
      { status: 'missing', category: 'labor', your: { description: 'General Laborer - per hour', qty: '8.00 HR', remove: 0, replace: 457.06, tax: 0, op: 0, total: 457.06 }, adjuster: null },
      { status: 'modified', category: 'supervision', your: { description: 'Residential Supervision / Project Management - per hour', qty: '180.00 HR', remove: 0, replace: 16860.96, tax: 0, op: 0, total: 16860.96 }, adjuster: { description: 'Residential Supervision / Project Management - per hour', qty: '16.00 HR', remove: 0, replace: 1740.02, tax: 0, op: 0, total: 1740.02 } },
      { status: 'missing', category: 'permits', your: { description: 'PERMITS AND FEES', qty: '1.00 EA', remove: 0, replace: 0, tax: 0, op: 0, total: 0, totalDisplay: 'OPEN' }, adjuster: null },
      { status: 'match', category: 'electrical', your: { description: 'R&R Temporary power - overhead hookup', qty: '1.00 EA', remove: 152.45, replace: 457.35, tax: 0, op: 0, total: 762.26 }, adjuster: { description: 'Floor protection - plastic and tape - 10 mil', qty: '250.00 SF', remove: 0, replace: 106.89, tax: 8.55, op: 18.17, total: 133.61 } },
      { status: 'missing', category: 'electrical', your: { description: 'Temporary power usage (per month)', qty: '6.00 MO', remove: 0, replace: 1910.41, tax: 0, op: 0, total: 1910.41 }, adjuster: null },
      { status: 'missing', category: 'general-conditions', your: { description: 'Temporary toilet (per month)', qty: '6.00 MO', remove: 0, replace: 1162.80, tax: 0, op: 0, total: 1162.80 }, adjuster: null },
      { status: 'added', category: 'cleaning', your: null, adjuster: { description: 'Cleaning Technician - per hour - general', qty: '8.00 HR', remove: 0, replace: 387.17, tax: 0, op: 96.79, total: 483.96 } },
      { status: 'added', category: 'electrical', your: null, adjuster: { description: 'Megohmmeter check electrical circuits - average residence', qty: '1.00 EA', remove: 0, replace: 1281.26, tax: 102.72, op: 217.59, total: 1601.57 } },
    ]
  },
  {
    id: 'kitchen', canonicalName: 'Kitchen', yourName: 'Kitchen', adjusterName: 'Kitchen', confidence: 100,
    items: [
      { status: 'modified', category: 'cabinetry', your: { description: 'R&R Base cabinets - wood - 30 linear feet', qty: '30.00 LF', remove: 450, replace: 3150, tax: 252, op: 398, total: 4250 }, adjuster: { description: 'R&R Base cabinets - economy grade - 30 LF', qty: '30.00 LF', remove: 300, replace: 2100, tax: 168, op: 232, total: 2800 } },
      { status: 'missing', category: 'countertops', your: { description: 'Countertop - Granite slab - standard grade', qty: '45.00 SF', remove: 185, replace: 2450.50, tax: 196.04, op: 293.96, total: 3125.50 }, adjuster: null },
      { status: 'match', category: 'flooring', your: { description: 'Flooring - Ceramic tile - standard grade', qty: '120.00 SF', remove: 0, replace: 1512, tax: 120.96, op: 257.04, total: 1890 }, adjuster: { description: 'Flooring - Ceramic tile - standard grade', qty: '120.00 SF', remove: 0, replace: 1536, tax: 122.88, op: 261.12, total: 1920 } },
      { status: 'added', category: 'appliances', your: null, adjuster: { description: 'R&R Dishwasher - built-in - standard', qty: '1.00 EA', remove: 85, replace: 340, tax: 27.20, op: 32.80, total: 485 } },
      { status: 'modified', category: 'painting', your: { description: 'Painting walls & ceiling - two coats', qty: '450.00 SF', remove: 0, replace: 960, tax: 48, op: 192, total: 1200 }, adjuster: { description: 'Painting walls & ceiling - two coats', qty: '450.00 SF', remove: 0, replace: 700, tax: 35, op: 140, total: 875 } },
    ]
  },
  {
    id: 'bathroom', canonicalName: 'Bathroom', yourName: 'Bathroom - Main', adjusterName: 'Bathroom', confidence: 88,
    items: [
      { status: 'match', category: 'plumbing', your: { description: 'R&R Toilet - standard grade', qty: '1.00 EA', remove: 95, replace: 285.50, tax: 0, op: 20, total: 485.50 }, adjuster: { description: 'R&R Toilet - standard grade', qty: '1.00 EA', remove: 95, replace: 285.50, tax: 0, op: 20, total: 485.50 } },
      { status: 'modified', category: 'flooring', your: { description: 'Tile - Floor ceramic 12x12 - thin set', qty: '85.00 SF', remove: 210, replace: 1155, tax: 92.40, op: 192.60, total: 1650 }, adjuster: { description: 'Tile - Floor ceramic 12x12 - thin set', qty: '85.00 SF', remove: 125, replace: 685, tax: 54.80, op: 115.20, total: 980 } },
      { status: 'missing', category: 'cabinetry', your: { description: 'Vanity with countertop - cultured marble', qty: '1.00 EA', remove: 145, replace: 1425, tax: 114, op: 191, total: 1875 }, adjuster: null },
      { status: 'match', category: 'plumbing', your: { description: 'R&R Plumbing fixtures - standard grade', qty: '1.00 EA', remove: 120, replace: 385, tax: 30.80, op: 49.20, total: 720 }, adjuster: { description: 'R&R Plumbing fixtures - standard grade', qty: '1.00 EA', remove: 115, replace: 370, tax: 29.60, op: 50.40, total: 695 } },
    ]
  }
];

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type StatusFilter = 'match' | 'match_unverified' | 'modified' | 'missing' | 'added';

const statusLabel: Record<StatusFilter, string> = {
  match: 'Matching',
  match_unverified: 'Price Unverified',
  modified: 'Contradicting',
  missing: 'Missing',
  added: 'Adjuster Added',
};

const thresholds = [
  { value: 0, label: 'All' },
  { value: 100, label: '$100+' },
  { value: 500, label: '$500+' },
  { value: 1000, label: '$1k+' },
];

const costColumns: { key: keyof LineItem; label: string }[] = [
  { key: 'remove', label: 'Remove' },
  { key: 'replace', label: 'Replace' },
  { key: 'tax', label: 'Tax' },
  { key: 'op', label: 'O&P' },
];

type EditValues = {
  yDesc: string; aDesc: string;
  yQty: string; aQty: string;
  yRemove: string; aRemove: string;
  yReplace: string; aReplace: string;
  yTax: string; aTax: string;
  yOp: string; aOp: string;
  yTotal: string; aTotal: string;
  deleted?: boolean;
};

function blankEditValues(): EditValues {
  return { yDesc: '', aDesc: '', yQty: '', aQty: '', yRemove: '', aRemove: '', yReplace: '', aReplace: '', yTax: '', aTax: '', yOp: '', aOp: '', yTotal: '', aTotal: '' };
}

type DraftInsert = {
  tempId: string;
  insertBeforeItemId: string;
  zoneCanonical: string;
  zoneYours: string | null;
  zoneAdjuster: string | null;
  isNewZone: boolean;
  parentZoneTempId?: string;
};

function numericKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.ctrlKey || e.metaKey) return; // allow Ctrl+A/C/V/X
  const nav = ['Backspace','Delete','Tab','Escape','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
  if (nav.includes(e.key)) return;
  if (/^[0-9.]$/.test(e.key)) return;
  e.preventDefault();
}

export default function ComparisonDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const comparisonId = params?.id;
  const yourEstimateDownloadHref = comparisonId ? `/api/comparisons/${comparisonId}/estimate?side=your` : null;
  const adjusterEstimateDownloadHref = comparisonId ? `/api/comparisons/${comparisonId}/estimate?side=adjuster` : null;

  const [comparison, setComparison] = useState<ApiComparisonDetail | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeFilters, setActiveFilters] = useState<Set<StatusFilter>>(
    new Set(['match', 'match_unverified', 'modified', 'missing', 'added'])
  );
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [minDiff, setMinDiff] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleCosts, setVisibleCosts] = useState<string[]>([]);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [collapsedZones, setCollapsedZones] = useState<Set<string>>(new Set());
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const printDate = useMemo(() =>
    new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    []
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRenamingHeader, setIsRenamingHeader] = useState(false);
  const [renameHeaderValue, setRenameHeaderValue] = useState('');
  const [renameHeaderSaving, setRenameHeaderSaving] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [llmEditOpen, setLlmEditOpen] = useState(false);
  const [llmEditPrompt, setLlmEditPrompt] = useState('');
  const [llmEditLoading, setLlmEditLoading] = useState(false);
  const [llmEditError, setLlmEditError] = useState<string | null>(null);
  const [llmEditSuccess, setLlmEditSuccess] = useState<string | null>(null);
  const [versions, setVersions] = useState<Array<{ id: string; versionNumber: number; label: string; editPrompt: string | null; isActive: boolean; createdAt: string }>>([]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionDeleteConfirm, setVersionDeleteConfirm] = useState<string | null>(null);
  const [versionDeleteError, setVersionDeleteError] = useState<string | null>(null);
  const [noteTarget, setNoteTarget] = useState<NoteLineItemContext | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const [notesByLineItem, setNotesByLineItem] = useState<Map<string, number>>(new Map());
  const [printNotes, setPrintNotes] = useState<Note[]>([]);
  const [adjusterCollapsed, setAdjusterCollapsed] = useState(false);
  const [diffCollapsed, setDiffCollapsed] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryMarkdown, setSummaryMarkdown] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryConfirmOpen, setSummaryConfirmOpen] = useState(false);
  const [summaryConfirmIsRegen, setSummaryConfirmIsRegen] = useState(false);
  const [summaryUsage, setSummaryUsage] = useState<{ used: number; limit: number } | null>(null);
  const [summaryUsageLoading, setSummaryUsageLoading] = useState(false);
  const [summaryInstructions, setSummaryInstructions] = useState('');
  const [n2ReviewZones, setN2ReviewZones] = useState<{ e1: ReviewZone[]; e2: ReviewZone[] } | null>(null);
  const [n2MatchData, setN2MatchData] = useState<{ pairs: MatchPair[]; unmatchedE1: string[]; unmatchedE2: string[] } | null>(null);
  const [n3LineItemData, setN3LineItemData] = useState<{ yours: LineItemZoneRow[]; adjuster: LineItemZoneRow[]; yoursTotal: number; adjusterTotal: number } | null>(null);
  const [isAwaitingNextPass, setIsAwaitingNextPass] = useState(false);
  const [isAwaitingExtractPhase, setIsAwaitingExtractPhase] = useState(false);
  const [isAwaitingLineItemPhase, setIsAwaitingLineItemPhase] = useState(false);
  const [awaitingPercent, setAwaitingPercent] = useState(0);
  const [awaitingElapsed, setAwaitingElapsed] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [rowNoteMenu, setRowNoteMenu] = useState<{ x: number; y: number; rowKey: string; target: NoteLineItemContext; row: Row; isZoneRow?: boolean; zoneId?: string; zoneEditSide?: 'yours' | 'adjuster' } | null>(null);
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [flashedRowKey, setFlashedRowKey] = useState<string | null>(null);
  const [editingValues, setEditingValues] = useState<EditValues>(blankEditValues());
  const [draftEdits, setDraftEdits] = useState<Map<string, EditValues>>(new Map());
  const [draftZoneNames, setDraftZoneNames] = useState<Map<string, string>>(new Map());
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editingZoneName, setEditingZoneName] = useState('');
  const [editingZoneSide, setEditingZoneSide] = useState<'yours' | 'adjuster'>('yours');
  const [draftAdjusterZoneNames, setDraftAdjusterZoneNames] = useState<Map<string, string>>(new Map());
  const [savingDraft, setSavingDraft] = useState(false);
  const [unsavedGuardOpen, setUnsavedGuardOpen] = useState(false);
  const [saveDraftErrors, setSaveDraftErrors] = useState<string[] | null>(null);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [deleteZoneConfirm, setDeleteZoneConfirm] = useState<{ zoneName: string; rowIds: string[] } | null>(null);
  const [gateExitConfirmOpen, setGateExitConfirmOpen] = useState(false);
  const [gateExiting, setGateExiting] = useState(false);
  const unsavedGuardCallbackRef = useRef<(() => void) | null>(null);
  const draftEditsRef = useRef<Map<string, EditValues>>(new Map());
  const draftZoneNamesRef = useRef<Map<string, string>>(new Map());
  const draftAdjusterZoneNamesRef = useRef<Map<string, string>>(new Map());
  const [draftInserts, setDraftInserts] = useState<Map<string, DraftInsert>>(new Map());
  const draftInsertsRef = useRef<Map<string, DraftInsert>>(new Map());
  const [draftMoves, setDraftMoves] = useState<Map<string, string>>(new Map()); // rowId → targetZoneId
  const draftMovesRef = useRef<Map<string, string>>(new Map());
  const [moveToZoneSubmenu, setMoveToZoneSubmenu] = useState<{ side: 'right' | 'left' } | null>(null);
  type DraftSnapshot = { edits: Map<string, EditValues>; zoneNames: Map<string, string>; adjusterZoneNames: Map<string, string>; inserts: Map<string, DraftInsert>; moves: Map<string, string>; };
  const undoStackRef = useRef<DraftSnapshot[]>([]);
  const [undoStack, setUndoStack] = useState<DraftSnapshot[]>([]);
  const redoStackRef = useRef<DraftSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<DraftSnapshot[]>([]);
  
  const zonesRef = useRef<Zone[]>([]);
  const editingRowIdRef = useRef<string | null>(null);
  const editingOriginalRef = useRef<EditValues | null>(null);
  const editingValuesRef = useRef<EditValues>(blankEditValues());
  const [tableScrollOverlay, setTableScrollOverlay] = useState<{ visible: boolean; left: number; width: number; contentWidth: number }>({
    visible: false,
    left: 0,
    width: 0,
    contentWidth: 0,
  });
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const rowNoteMenuRef = useRef<HTMLDivElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const tableScrollOverlayRef = useRef<HTMLDivElement>(null);
  const syncingTableScrollRef = useRef(false);

  const zonesWithInserts = useMemo((): Zone[] => {
    if (draftInserts.size === 0 && draftMoves.size === 0) return zones;
    const lineItemInsBefore = new Map<string, DraftInsert[]>();
    const newZoneInsBefore = new Map<string, DraftInsert[]>();
    const childLineItemsForZone = new Map<string, DraftInsert[]>();
    for (const ins of draftInserts.values()) {
      if (ins.isNewZone) {
        const list = newZoneInsBefore.get(ins.insertBeforeItemId) ?? [];
        newZoneInsBefore.set(ins.insertBeforeItemId, [ins, ...list]);
      } else if (ins.parentZoneTempId) {
        const list = childLineItemsForZone.get(ins.parentZoneTempId) ?? [];
        childLineItemsForZone.set(ins.parentZoneTempId, [...list, ins]);
      } else {
        const list = lineItemInsBefore.get(ins.insertBeforeItemId) ?? [];
        lineItemInsBefore.set(ins.insertBeforeItemId, [...list, ins]);
      }
    }
    const buildVirtual = (ins: DraftInsert): Row => {
      const v = draftEdits.get(ins.tempId) ?? blankEditValues();
      const hasY = !!(v.yDesc || v.yTotal);
      const hasA = !!(v.aDesc || v.aTotal);
      return {
        id: ins.tempId,
        status: hasY && hasA ? 'modified' : hasA ? 'added' : 'missing',
        category: 'uncategorized',
        your: hasY ? { description: v.yDesc, qty: v.yQty, remove: parseFloat(v.yRemove) || 0, replace: parseFloat(v.yReplace) || 0, tax: parseFloat(v.yTax) || 0, op: parseFloat(v.yOp) || 0, total: parseFloat(v.yTotal) || 0 } : null,
        adjuster: hasA ? { description: v.aDesc, qty: v.aQty, remove: parseFloat(v.aRemove) || 0, replace: parseFloat(v.aReplace) || 0, tax: parseFloat(v.aTax) || 0, op: parseFloat(v.aOp) || 0, total: parseFloat(v.aTotal) || 0 } : null,
      };
    };
    const newZoneBeforeZone = new Map<string, DraftInsert[]>();
    for (const zone of zones) {
      const firstRealId = zone.items.find(i => i.id)?.id;
      if (firstRealId && newZoneInsBefore.has(firstRealId)) {
        newZoneBeforeZone.set(zone.id, newZoneInsBefore.get(firstRealId)!);
      }
    }
    const result: Zone[] = [];
    for (const zone of zones) {
      for (const ins of (newZoneBeforeZone.get(zone.id) ?? [])) {
        const childItems = (childLineItemsForZone.get(ins.tempId) ?? []).map(buildVirtual);
        result.push({ id: `__newzone__${ins.tempId}`, canonicalName: ins.zoneCanonical, yourName: ins.zoneYours, adjusterName: ins.zoneAdjuster, confidence: null, items: [buildVirtual(ins), ...childItems] });
      }
      const newItems: Row[] = [];
      for (const item of zone.items) {
        for (const ins of (item.id ? (lineItemInsBefore.get(item.id) ?? []) : [])) {
          newItems.push(buildVirtual(ins));
        }
        newItems.push(item);
      }
      result.push({ ...zone, items: newItems });
    }
    // Apply draft moves: re-route rows from their current zone to a target zone
    if (draftMoves.size > 0) {
      // Collect moved rows keyed by targetZoneId
      const movedRowsByTarget = new Map<string, Row[]>();
      for (const z of result) {
        const kept: Row[] = [];
        for (const item of z.items) {
          const targetZoneId = item.id ? draftMoves.get(item.id) : undefined;
          if (targetZoneId && targetZoneId !== z.id) {
            const list = movedRowsByTarget.get(targetZoneId) ?? [];
            movedRowsByTarget.set(targetZoneId, [...list, item]);
          } else {
            kept.push(item);
          }
        }
        z.items = kept;
      }
      // Append moved rows to target zones
      for (const z of result) {
        const moved = movedRowsByTarget.get(z.id);
        if (moved) z.items = [...z.items, ...moved];
      }
    }
    return result;
  }, [zones, draftInserts, draftEdits, draftMoves]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pageMenuRef.current && !pageMenuRef.current.contains(e.target as Node)) {
        setPageMenuOpen(false);
        setConfirmDelete(false);
      }
    }
    if (pageMenuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pageMenuOpen]);

  useEffect(() => {
    if (!rowNoteMenu) return;

    function handleOutsideClick(e: MouseEvent) {
      if (rowNoteMenuRef.current && !rowNoteMenuRef.current.contains(e.target as Node)) {
        setRowNoteMenu(null);
        setMoveToZoneSubmenu(null);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setRowNoteMenu(null);
        setMoveToZoneSubmenu(null);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [rowNoteMenu]);

  useEffect(() => {
    if (!llmEditOpen) return;

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setLlmEditOpen(false);
      }
    }

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [llmEditOpen]);

  useEffect(() => {
    if (!summaryOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setSummaryOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [summaryOpen]);

  useEffect(() => {
    if (!summaryConfirmOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setSummaryConfirmOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [summaryConfirmOpen]);

  // Deselect row when clicking outside any data row
  useEffect(() => {
    if (!selectedRow) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest('tr[data-row-key]')) {
        setSelectedRow(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [selectedRow]);

  // Keep editingValuesRef in sync so mousedown listener never sees stale values
  useEffect(() => { editingValuesRef.current = editingValues; }, [editingValues]);
  useEffect(() => { zonesRef.current = zonesWithInserts; }, [zonesWithInserts]);

  // Global mousedown listener: commit (or discard if no-op) when clicking outside the editing row
  useEffect(() => {
    if (!editingRowKey) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      // Keep edit mode active while dragging/clicking horizontal scrollbars.
      if (tableScrollOverlayRef.current && tableScrollOverlayRef.current.contains(target)) return;
      if (tableWrapRef.current && target === tableWrapRef.current) return;

      const rowEl = document.querySelector(`tr[data-row-key="${editingRowKey}"]`);
      if (rowEl && rowEl.contains(target)) return;
      const rowId = editingRowIdRef.current;
      if (rowId) {
        const values = editingValuesRef.current;
        const original = editingOriginalRef.current;
        const hasChanged = original
          ? (Object.keys(values) as (keyof EditValues)[]).some(k => values[k] !== original[k])
          : true;
        if (hasChanged) {
          const next = new Map(draftEditsRef.current);
          next.set(rowId, { ...values });
          draftEditsRef.current = next;
          setDraftEdits(next);
        }
      }
      editingRowIdRef.current = null;
      setEditingRowKey(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [editingRowKey]);

  useEffect(() => {
    if (draftEdits.size === 0) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [draftEdits.size]);

  useEffect(() => {
    const isGate = comparison?.status === 'AWAITING_ZONE_REVIEW' || comparison?.status === 'AWAITING_MATCH_REVIEW' || comparison?.status === 'AWAITING_LINE_ITEM_REVIEW';
    if (!isGate) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = ''; }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [comparison?.status]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('comparison-table-collapsed-sides');
      if (!saved) return;
      const parsed = JSON.parse(saved) as { adjusterCollapsed?: boolean; diffCollapsed?: boolean };
      setAdjusterCollapsed(Boolean(parsed.adjusterCollapsed));
      setDiffCollapsed(Boolean(parsed.diffCollapsed));
    } catch {
      // ignore invalid persisted UI state
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        'comparison-table-collapsed-sides',
        JSON.stringify({ adjusterCollapsed, diffCollapsed })
      );
    } catch {
      // ignore storage errors
    }
  }, [adjusterCollapsed, diffCollapsed]);


  useEffect(() => {
    function updateViewportWidth() {
      setViewportWidth(window.innerWidth);
    }

    updateViewportWidth();
    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

  const handleDownloadPdf = useCallback(() => {
    window.print();
  }, []);

  const handleDeleteComparison = useCallback(async () => {
    if (!comparisonId) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed.');
      router.push('/app/comparisons');
    } catch {
      setIsDeleting(false);
      setConfirmDelete(false);
      setPageMenuOpen(false);
    }
  }, [comparisonId, router]);

  const handleRenameHeader = useCallback(async () => {
    const trimmed = renameHeaderValue.trim();
    if (!trimmed || !comparisonId) return;
    setRenameHeaderSaving(true);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? 'Failed to rename.');
      setComparison(prev => prev ? { ...prev, name: trimmed } : prev);
      setIsRenamingHeader(false);
    } catch {
      // leave rename mode open so the user can retry
    } finally {
      setRenameHeaderSaving(false);
    }
  }, [comparisonId, renameHeaderValue]);

  const openNoteForLineItem = useCallback((li: NoteLineItemContext) => {
    setNoteTarget(li);
    setNotesOpen(true);
  }, []);

  const handleNotesLoaded = useCallback((count: number) => { setNoteCount(count); }, []);
  const handleNotesByLineItem = useCallback((map: Map<string, number>) => { setNotesByLineItem(map); }, []);
  const handleNotesData = useCallback((notes: Note[]) => { setPrintNotes(notes); }, []);

  const openRowNoteMenu = useCallback((e: ReactMouseEvent, rowKey: string, target: NoteLineItemContext, row: Row) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 220;
    const menuHeight = 240;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8));
    setRowNoteMenu({ x, y, rowKey, target, row });
  }, []);

  const openZoneRowMenu = useCallback((e: ReactMouseEvent, zone: Zone, side: 'yours' | 'adjuster' = 'yours') => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 220;
    const menuHeight = 160;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8));
    setRowNoteMenu({
      x, y,
      rowKey: `zh-${zone.id}`,
      target: { id: zone.id, descriptionYours: zone.canonicalName, descriptionAdjuster: zone.adjusterName ?? zone.canonicalName, zoneCanonical: zone.canonicalName },
      row: { id: zone.id, status: 'match', category: '', your: null, adjuster: null },
      isZoneRow: true,
      zoneId: zone.id,
      zoneEditSide: side,
    });
  }, [])

  const handleStartEditZone = useCallback(() => {
    if (!rowNoteMenu?.isZoneRow || !rowNoteMenu.zoneId) return;
    const side = rowNoteMenu.zoneEditSide ?? 'yours';
    setEditingZoneSide(side);
    let currentName: string;
    if (rowNoteMenu.zoneId.startsWith('__newzone__')) {
      currentName = side === 'adjuster'
        ? (rowNoteMenu.target.descriptionAdjuster ?? rowNoteMenu.target.zoneCanonical ?? '')
        : (rowNoteMenu.target.zoneCanonical ?? '');
    } else {
      const zone = zonesRef.current.find(z => z.id === rowNoteMenu.zoneId);
      if (!zone) return;
      currentName = side === 'adjuster'
        ? (draftAdjusterZoneNamesRef.current.get(rowNoteMenu.zoneId) ?? zone.adjusterName ?? zone.canonicalName)
        : (draftZoneNamesRef.current.get(rowNoteMenu.zoneId) ?? zone.canonicalName);
    }
    setEditingZoneId(rowNoteMenu.zoneId);
    setEditingZoneName(currentName);
    setRowNoteMenu(null);
  }, [rowNoteMenu]);

  const handleDoubleClickZone = useCallback((zone: Zone, side: 'yours' | 'adjuster') => {
    if (editingZoneId) return;
    const currentName = side === 'adjuster'
      ? (zone.id.startsWith('__newzone__')
          ? (zone.adjusterName ?? zone.canonicalName)
          : (draftAdjusterZoneNamesRef.current.get(zone.id) ?? zone.adjusterName ?? zone.canonicalName))
      : (zone.id.startsWith('__newzone__')
          ? zone.canonicalName
          : (draftZoneNamesRef.current.get(zone.id) ?? zone.canonicalName));
    setEditingZoneSide(side);
    setEditingZoneId(zone.id);
    setEditingZoneName(currentName);
    setRowNoteMenu(null);
  }, [editingZoneId]);

  const pushSnapshot = useCallback(() => {
    const snap: DraftSnapshot = {
      edits: new Map(draftEditsRef.current),
      zoneNames: new Map(draftZoneNamesRef.current),
      adjusterZoneNames: new Map(draftAdjusterZoneNamesRef.current),
      inserts: new Map(draftInsertsRef.current),
      moves: new Map(draftMovesRef.current),
    };
    undoStackRef.current = [...undoStackRef.current, snap];
    setUndoStack([...undoStackRef.current]);
    redoStackRef.current = [];
    setRedoStack([]);
  }, []);

  const applySnapshot = useCallback((snap: DraftSnapshot) => {
    draftEditsRef.current = snap.edits;
    setDraftEdits(snap.edits);
    draftZoneNamesRef.current = snap.zoneNames;
    setDraftZoneNames(snap.zoneNames);
    draftAdjusterZoneNamesRef.current = snap.adjusterZoneNames;
    setDraftAdjusterZoneNames(snap.adjusterZoneNames);
    draftInsertsRef.current = snap.inserts;
    setDraftInserts(snap.inserts);
    draftMovesRef.current = snap.moves;
    setDraftMoves(snap.moves);
  }, []);

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    const current: DraftSnapshot = {
      edits: new Map(draftEditsRef.current),
      zoneNames: new Map(draftZoneNamesRef.current),
      adjusterZoneNames: new Map(draftAdjusterZoneNamesRef.current),
      inserts: new Map(draftInsertsRef.current),
      moves: new Map(draftMovesRef.current),
    };
    redoStackRef.current = [...redoStackRef.current, current];
    setRedoStack([...redoStackRef.current]);
    undoStackRef.current = stack.slice(0, -1);
    setUndoStack([...undoStackRef.current]);
    applySnapshot(prev);
  }, [applySnapshot]);

  const handleRedo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    const current: DraftSnapshot = {
      edits: new Map(draftEditsRef.current),
      zoneNames: new Map(draftZoneNamesRef.current),
      adjusterZoneNames: new Map(draftAdjusterZoneNamesRef.current),
      inserts: new Map(draftInsertsRef.current),
      moves: new Map(draftMovesRef.current),
    };
    undoStackRef.current = [...undoStackRef.current, current];
    setUndoStack([...undoStackRef.current]);
    redoStackRef.current = stack.slice(0, -1);
    setRedoStack([...redoStackRef.current]);
    applySnapshot(next);
  }, [applySnapshot]);

  const handleResetAllChanges = useCallback(() => {
    pushSnapshot();
    const empty = { edits: new Map<string, EditValues>(), zoneNames: new Map<string, string>(), adjusterZoneNames: new Map<string, string>(), inserts: new Map<string, DraftInsert>(), moves: new Map<string, string>() };
    applySnapshot(empty);
  }, [pushSnapshot, applySnapshot]);

  const handleCommitZoneEdit = useCallback((zoneId: string, originalCanonical: string) => {
    const trimmed = editingZoneName.trim();
    const side = editingZoneSide;
    setEditingZoneId(null);
    setEditingZoneName('');
    setEditingZoneSide('yours');
    if (!trimmed) return;
    pushSnapshot();
    if (zoneId.startsWith('__newzone__')) {
      const tempId = zoneId.slice('__newzone__'.length);
      const nextIns = new Map(draftInsertsRef.current);
      const existingIns = nextIns.get(tempId);
      if (existingIns) {
        if (side === 'adjuster') {
          nextIns.set(tempId, { ...existingIns, zoneAdjuster: trimmed });
        } else {
          nextIns.set(tempId, { ...existingIns, zoneCanonical: trimmed, zoneYours: trimmed });
        }
        draftInsertsRef.current = nextIns;
        setDraftInserts(nextIns);
      }
      return;
    }
    if (side === 'adjuster') {
      const zone = zonesRef.current.find(z => z.id === zoneId);
      const originalAdj = zone?.adjusterName ?? originalCanonical;
      if (trimmed === originalAdj) return;
      const next = new Map(draftAdjusterZoneNamesRef.current);
      next.set(zoneId, trimmed);
      draftAdjusterZoneNamesRef.current = next;
      setDraftAdjusterZoneNames(next);
    } else {
      if (trimmed === originalCanonical) return;
      const next = new Map(draftZoneNamesRef.current);
      next.set(zoneId, trimmed);
      draftZoneNamesRef.current = next;
      setDraftZoneNames(next);
    }
  }, [editingZoneName, editingZoneSide]);

  const handleCancelZoneEdit = useCallback(() => {
    setEditingZoneId(null);
    setEditingZoneName('');
    setEditingZoneSide('yours');
  }, []);

  const handleMakeRowNote = useCallback(() => {
    if (!rowNoteMenu) return;
    openNoteForLineItem(rowNoteMenu.target);
    setRowNoteMenu(null);
  }, [rowNoteMenu, openNoteForLineItem]);

  const handleMoveToZone = useCallback((targetZoneId: string) => {
    if (!rowNoteMenu?.row.id) return;
    const rowId = rowNoteMenu.row.id;
    pushSnapshot();
    const next = new Map(draftMovesRef.current);
    next.set(rowId, targetZoneId);
    draftMovesRef.current = next;
    setDraftMoves(next);
    setMoveToZoneSubmenu(null);
    setRowNoteMenu(null);
  }, [rowNoteMenu, pushSnapshot]);

  const versionHistoryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!versionHistoryOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (versionHistoryRef.current && !versionHistoryRef.current.contains(e.target as Node)) {
        setVersionHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [versionHistoryOpen]);

  const fetchVersions = useCallback(async () => {
    if (!comparisonId) return;
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/versions`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.versions)) {
        setVersions(data.versions);
        const active = data.versions.find((v: { isActive: boolean }) => v.isActive);
        if (active) setActiveVersionId(active.id);
      }
    } catch {
      // silent
    }
  }, [comparisonId]);

  const loadVersionZones = useCallback(async (versionId: string) => {
    if (!comparisonId) return;
    setVersionLoading(true);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/versions/${versionId}`);
      if (!res.ok) throw new Error('Failed to load version.');
      const data = await res.json();
      if (data.zones) {
        setZones(data.zones);
        setActiveVersionId(versionId);
      }
    } catch {
      // silent
    } finally {
      setVersionLoading(false);
    }
  }, [comparisonId]);

  const activateVersion = useCallback(async (versionId: string) => {
    if (!comparisonId) return;
    setVersionLoading(true);
    setVersionError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/versions/${versionId}/activate`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to activate version.');
      }
      await loadVersionZones(versionId);
      await fetchVersions();
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : 'Failed to switch version.');
    } finally {
      setVersionLoading(false);
      setVersionHistoryOpen(false);
    }
  }, [comparisonId, loadVersionZones, fetchVersions]);

  const deleteVersion = useCallback(async (versionId: string) => {
    if (!comparisonId) return;
    setVersionLoading(true);
    setVersionDeleteError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/versions/${versionId}/delete`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to delete version.');
      }
      setVersionDeleteConfirm(null);
      setVersionDeleteError(null);
      // Refresh versions list and load the new active version
      const versRes = await fetch(`/api/comparisons/${comparisonId}/versions`);
      if (versRes.ok) {
        const versData = await versRes.json();
        if (Array.isArray(versData.versions)) {
          setVersions(versData.versions);
          const active = versData.versions.find((v: { isActive: boolean }) => v.isActive);
          if (active) {
            await loadVersionZones(active.id);
          }
        }
      }
    } catch (err) {
      setVersionDeleteError(err instanceof Error ? err.message : 'Failed to delete version.');
    } finally {
      setVersionLoading(false);
    }
  }, [comparisonId, loadVersionZones]);

  /* Filter logic — must be defined before handleLlmEditSubmit which depends on it */
  const isRowVisible = useCallback((row: Row, zoneId: string): boolean => {
    if (row.id?.startsWith('__new__')) return true;
    if (draftEditsRef.current.get(row.id ?? '')?.deleted) return false;
    if (!activeFilters.has(row.status)) return false;
    if (search) {
      const desc = ((row.your?.description ?? '') + ' ' + (row.adjuster?.description ?? '')).toLowerCase();
      if (!desc.includes(search.toLowerCase())) return false;
    }
    if (zoneFilter && zoneId !== zoneFilter) return false;
    if (minDiff > 0) {
      const diff = Math.abs((row.your?.total ?? 0) - (row.adjuster?.total ?? 0));
      if (diff < minDiff) return false;
    }
    return true;
  }, [activeFilters, search, zoneFilter, minDiff]);

  const handleLlmEditSubmit = useCallback(async () => {
    if (!comparisonId || !llmEditPrompt.trim() || llmEditLoading) return;

    setLlmEditLoading(true);
    setLlmEditError(null);
    setLlmEditSuccess(null);

    try {
      // Ensure version 1 snapshot exists before applying edits
      await fetch(`/api/comparisons/${comparisonId}/versions`, { method: 'POST' });

      // Build the display-ordered item IDs so the backend knows exactly
      // which row number corresponds to which item (matching UI filters + zone sort)
      const displayItemIds: string[] = [];
      for (const zone of zones) {
        for (const item of zone.items) {
          if (item.id && isRowVisible(item, zone.id)) {
            displayItemIds.push(item.id);
          }
        }
      }

      const res = await fetch(`/api/comparisons/${comparisonId}/versions/apply-edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: llmEditPrompt.trim(), displayItemIds }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.code === 'USAGE_LIMIT_REACHED') {
          if (data?.isTrial) {
            window.dispatchEvent(new CustomEvent('trial-limit-reached', { detail: { kind: 'llmEdit', limit: data?.limit ?? 2 } }));
            throw new Error(data?.error ?? 'You have reached your trial bulk edit limit.');
          }
          if (data?.refreshDate) {
            const refresh = new Date(data.refreshDate);
            const refreshLabel = Number.isNaN(refresh.getTime())
              ? null
              : refresh.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            throw new Error(
              refreshLabel
                ? `${data.error} Your quota resets on ${refreshLabel}.`
                : data.error
            );
          }
        }
        throw new Error(data?.error ?? 'Failed to apply edits.');
      }

      const data = await res.json();

      // Load the new version's zones into the UI
      if (data.version?.id) {
        await loadVersionZones(data.version.id);
        await fetchVersions();
      }

      setLlmEditPrompt('');
      setLlmEditSuccess(data.editsSummary ?? `Applied ${data.editsApplied ?? 0} change(s) as a new version.`);
    } catch (err) {
      setLlmEditError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLlmEditLoading(false);
    }
  }, [comparisonId, llmEditPrompt, llmEditLoading, loadVersionZones, fetchVersions, zones, isRowVisible]);

  const handleSummaryConfirmOpen = useCallback(async (isRegen = false) => {
    if (summaryLoading || !comparisonId) return;
    setSummaryConfirmIsRegen(isRegen);
    setSummaryConfirmOpen(true);
    setSummaryUsageLoading(true);
    setSummaryUsage(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/executive-summary`);
      if (res.ok) setSummaryUsage(await res.json());
    } catch {
      // silently fail — dialog still works, just won't show usage count
    } finally {
      setSummaryUsageLoading(false);
    }
  }, [comparisonId, summaryLoading]);

  const handleGenerateSummary = useCallback(async () => {
    if (!comparisonId || summaryLoading) return;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummaryOpen(true);
    try {
      const body: { instructions?: string } = {};
      if (summaryInstructions.trim()) body.instructions = summaryInstructions.trim();
      const res = await fetch(`/api/comparisons/${comparisonId}/executive-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // Show refusal errors as a red banner without clearing existing content
        if (res.status === 422 && data?.error?.includes('could not generate a report')) {
          setSummaryError(data.error);
          return;
        }
        if (data?.code === 'USAGE_LIMIT_REACHED') {
          if (data?.isTrial) {
            window.dispatchEvent(new CustomEvent('trial-limit-reached', { detail: { kind: 'executiveSummary', limit: data?.limit ?? 2 } }));
            throw new Error(data?.error ?? 'You have reached your trial executive summary limit.');
          }
          if (data?.refreshDate) {
            const refresh = new Date(data.refreshDate);
            const refreshLabel = Number.isNaN(refresh.getTime())
              ? null
              : refresh.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            throw new Error(
              refreshLabel
                ? `${data.error} Your quota resets on ${refreshLabel}.`
                : data.error
            );
          }
        }
        throw new Error(data?.error ?? 'Failed to generate summary.');
      }
      const data = await res.json();
      setSummaryMarkdown(data.markdown ?? null);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSummaryLoading(false);
    }
  }, [comparisonId, summaryLoading, summaryInstructions]);

  const handleSummaryConfirm = useCallback(() => {
    setSummaryConfirmOpen(false);
    void handleGenerateSummary();
  }, [handleGenerateSummary]);

  const handlePrintSummary = useCallback(() => {
    if (!summaryMarkdown) return;
    const html = markdownToHtml(summaryMarkdown);
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Executive Summary</title><style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:40px auto;max-width:900px;color:#111827;line-height:1.5}
      h1{font-size:22px;font-weight:800;margin:0 0 8px}
      h2{font-size:16px;font-weight:700;border-bottom:1px solid #d1d5db;padding-bottom:6px;margin:28px 0 12px;color:#111827}
      h3{font-size:14px;font-weight:600;margin:20px 0 8px}
      table{width:100%;border-collapse:collapse;margin:12px 0;font-size:11px}
      th,td{border:1px solid #d1d5db;padding:6px 10px;text-align:left}
      th{background:#f3f4f6;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.3px}
      td{font-size:11px}
      p{font-size:13px;line-height:1.65;margin:6px 0}
      ul,ol{margin:8px 0;padding-left:24px}
      li{font-size:13px;line-height:1.55;margin:4px 0}
      strong{font-weight:700}
      code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:12px}
      hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}
      @media print{body{margin:20px}}
    </style></head><body>${html}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 250);
  }, [summaryMarkdown]);

  const toggleAdjusterCollapsed = useCallback(() => {
    setAdjusterCollapsed(prev => !prev);
  }, []);

  const toggleDiffCollapsed = useCallback(() => {
    setDiffCollapsed(prev => !prev);
  }, []);

  const syncTableScrollOverlay = useCallback(() => {
    const tableWrapEl = tableWrapRef.current;
    if (!tableWrapEl || window.innerWidth <= 768) {
      setTableScrollOverlay(prev => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }

    const rect = tableWrapEl.getBoundingClientRect();
    const hasOverflow = tableWrapEl.scrollWidth - tableWrapEl.clientWidth > 1;
    const isOnScreen = rect.top < window.innerHeight && rect.bottom > 0;
    const left = Math.max(12, Math.round(rect.left));
    const width = Math.max(0, Math.min(Math.round(rect.width), window.innerWidth - left - 12));
    const visible = hasOverflow && isOnScreen && width > 0;

    setTableScrollOverlay(prev => {
      if (
        prev.visible === visible
        && prev.left === left
        && prev.width === width
        && prev.contentWidth === tableWrapEl.scrollWidth
      ) {
        return prev;
      }
      return {
        visible,
        left,
        width,
        contentWidth: tableWrapEl.scrollWidth,
      };
    });

    if (tableScrollOverlayRef.current && tableScrollOverlayRef.current.scrollLeft !== tableWrapEl.scrollLeft) {
      tableScrollOverlayRef.current.scrollLeft = tableWrapEl.scrollLeft;
    }
  }, []);

  const handleTableWrapScroll = useCallback(() => {
    const tableWrapEl = tableWrapRef.current;
    const overlayEl = tableScrollOverlayRef.current;
    if (!tableWrapEl) return;
    if (!overlayEl || syncingTableScrollRef.current) return;
    syncingTableScrollRef.current = true;
    overlayEl.scrollLeft = tableWrapEl.scrollLeft;
    requestAnimationFrame(() => {
      syncingTableScrollRef.current = false;
    });
  }, []);

  const handleOverlayScroll = useCallback(() => {
    const tableWrapEl = tableWrapRef.current;
    const overlayEl = tableScrollOverlayRef.current;
    if (!tableWrapEl || !overlayEl || syncingTableScrollRef.current) return;
    syncingTableScrollRef.current = true;
    tableWrapEl.scrollLeft = overlayEl.scrollLeft;
    requestAnimationFrame(() => {
      syncingTableScrollRef.current = false;
    });
  }, []);

  useEffect(() => {
    syncTableScrollOverlay();
    window.addEventListener('resize', syncTableScrollOverlay);
    window.addEventListener('scroll', syncTableScrollOverlay, { passive: true });
    return () => {
      window.removeEventListener('resize', syncTableScrollOverlay);
      window.removeEventListener('scroll', syncTableScrollOverlay);
    };
  }, [syncTableScrollOverlay, visibleCosts.length, adjusterCollapsed, diffCollapsed, zones.length]);

  const toggleZone = useCallback((zoneId: string) => {
    setCollapsedZones(prev => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!comparisonId) return;

    let isMounted = true;

    // Reset immediately so stale comparison data never flashes when
    // navigating between comparisons or arriving at a pipeline-gated status.
    setComparison(null);
    setZones([]);
    setIsLoading(true);
    setLoadError(null);

    async function loadComparison() {

      try {
        const response = await fetch(`/api/comparisons/${comparisonId}`, { method: 'GET' });
        const payload = (await response.json()) as {
          error?: string;
          comparison?: ApiComparisonDetail;
          zones?: Zone[];
        };

        if (!response.ok) {
          throw new Error(payload.error ?? 'Failed to load comparison.');
        }

        if (!payload.comparison) {
          throw new Error('Comparison payload was missing required data.');
        }

        if (!isMounted) return;

        // Fetch review data BEFORE calling setComparison so React batches
        // state updates into one render, ensuring review components mount
        // with the correct initial data.
        if (payload.comparison.status === 'AWAITING_ZONE_REVIEW') {
          try {
            const zrRes = await fetch(`/api/comparisons/${comparisonId}/zone-review`);
            if (zrRes.ok) {
              const zrData = await zrRes.json() as { e1Zones: ReviewZone[]; e2Zones: ReviewZone[] };
              if (isMounted) setN2ReviewZones({ e1: zrData.e1Zones, e2: zrData.e2Zones });
            }
          } catch {
            // non-fatal — ZoneReview will show empty lists
          }
        }

        if (payload.comparison.status === 'AWAITING_MATCH_REVIEW') {
          try {
            const mrRes = await fetch(`/api/comparisons/${comparisonId}/match-review`);
            if (mrRes.ok) {
              const mrData = await mrRes.json() as { pairs: MatchPair[]; unmatchedE1: string[]; unmatchedE2: string[] };
              if (isMounted) setN2MatchData(mrData);
            }
          } catch {
            // non-fatal — MatchReview will show empty lists
          }
        }

        if (payload.comparison.status === 'AWAITING_LINE_ITEM_REVIEW') {
          try {
            const lirRes = await fetch(`/api/comparisons/${comparisonId}/line-item-review`);
            if (lirRes.ok) {
              const lirData = await lirRes.json() as { yours: LineItemZoneRow[]; adjuster: LineItemZoneRow[]; yoursTotal: number; adjusterTotal: number };
              if (isMounted) setN3LineItemData(lirData);
            }
          } catch {
            // non-fatal — LineItemReview will show empty counts
          }
        }

        if (!isMounted) return;
        setComparison(payload.comparison);
        setZones(payload.zones ?? []);

        // After loading, check if there's an active version and load its zones instead
        try {
          const versRes = await fetch(`/api/comparisons/${comparisonId}/versions`);
          if (versRes.ok) {
            const versData = await versRes.json();
            if (isMounted && Array.isArray(versData.versions) && versData.versions.length > 0) {
              setVersions(versData.versions);
              const active = versData.versions.find((v: { isActive: boolean }) => v.isActive);
              if (active) {
                setActiveVersionId(active.id);
                // Always load the active version's zones so item IDs stay
                // consistent between UI display and the apply-edits route
                const vRes = await fetch(`/api/comparisons/${comparisonId}/versions/${active.id}`);
                if (vRes.ok) {
                  const vData = await vRes.json();
                  if (isMounted && vData.zones) {
                    setZones(vData.zones);
                  }
                }
              }
            }
          }
        } catch {
          // silent — versions are non-critical
        }
      } catch (error) {
        if (!isMounted) return;

        setLoadError(error instanceof Error ? error.message : 'Failed to load comparison.');
        setComparison(null);
        setZones(mockZones);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadComparison();

    return () => {
      isMounted = false;
    };
  }, [comparisonId]);

  // Poll every 4 s while status is PROCESSING so the UI picks up transitions
  // to AWAITING_ZONE_REVIEW or COMPLETED without a manual page refresh.
  useEffect(() => {
    if (comparison?.status !== 'PROCESSING' || !comparisonId) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/comparisons/${comparisonId}`);
        if (!res.ok) return;
        const payload = (await res.json()) as {
          comparison?: ApiComparisonDetail;
          zones?: Zone[];
        };
        if (!payload.comparison) return;

        // Fetch review data before updating comparison state so all updates
        // land in the same React batch — prevents a flash of the results page
        // while comparison.status is still the old value.
        if (payload.comparison.status === 'AWAITING_ZONE_REVIEW') {
          try {
            const zrRes = await fetch(`/api/comparisons/${comparisonId}/zone-review`);
            if (zrRes.ok) {
              const zrData = await zrRes.json() as { e1Zones: ReviewZone[]; e2Zones: ReviewZone[] };
              setN2ReviewZones({ e1: zrData.e1Zones, e2: zrData.e2Zones });
            }
          } catch {
            // non-fatal — ZoneReview shows empty lists
          }
        }

        if (payload.comparison.status === 'AWAITING_MATCH_REVIEW') {
          try {
            const mrRes = await fetch(`/api/comparisons/${comparisonId}/match-review`);
            if (mrRes.ok) {
              const mrData = await mrRes.json() as { pairs: MatchPair[]; unmatchedE1: string[]; unmatchedE2: string[] };
              setN2MatchData(mrData);
            }
          } catch {
            // non-fatal — MatchReview shows empty lists
          }
        }

        if (payload.comparison.status === 'AWAITING_LINE_ITEM_REVIEW') {
          try {
            const lirRes = await fetch(`/api/comparisons/${comparisonId}/line-item-review`);
            if (lirRes.ok) {
              const lirData = await lirRes.json() as { yours: LineItemZoneRow[]; adjuster: LineItemZoneRow[]; yoursTotal: number; adjusterTotal: number };
              setN3LineItemData(lirData);
            }
          } catch {
            // non-fatal — LineItemReview shows empty counts
          }
        }

        // Reset isAwaiting* flags here — after all secondary fetches — so this
        // lands in the same synchronous batch as setComparison. If reset before
        // the awaits, React may flush them while comparison.status is still
        // 'PROCESSING', causing the results page to render unpopulated.
        if (payload.comparison.status !== 'PROCESSING') {
          setIsAwaitingNextPass(false);
          setIsAwaitingExtractPhase(false);
          setIsAwaitingLineItemPhase(false);
        }

        setComparison(payload.comparison);
        setZones(payload.zones ?? []);
      } catch {
        // ignore transient poll errors
      }
    }, 4000);

    return () => clearInterval(id);
  }, [comparison?.status, comparisonId]);

  // Progress ticker for post-review waiting screens
  useEffect(() => {
    const isAny = isAwaitingNextPass || isAwaitingExtractPhase || isAwaitingLineItemPhase;
    if (!isAny) {
      setAwaitingPercent(0);
      setAwaitingElapsed(0);
      return;
    }
    setAwaitingPercent(8);
    setAwaitingElapsed(0);
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const target = Math.min(94, 10 + elapsed * 0.6);
      setAwaitingElapsed(elapsed);
      setAwaitingPercent(prev => (prev < target ? Math.min(target, prev + 1.5) : prev));
    }, 1000);
    return () => clearInterval(ticker);
  }, [isAwaitingNextPass, isAwaitingExtractPhase, isAwaitingLineItemPhase]);

  const availableCosts = useMemo(() => costColumns, []);

  const toggleCardDetail = useCallback((key: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleFilter = (f: StatusFilter) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const handleDiscrepancies = useCallback(() => {
    const allOn = activeFilters.size === 5;
    if (allOn) {
      setActiveFilters(new Set(['match_unverified', 'modified', 'missing', 'added']));
    } else {
      setActiveFilters(new Set(['match', 'match_unverified', 'modified', 'missing', 'added']));
    }
  }, [activeFilters]);

  const handleRowClick = useCallback((key: string) => {
    setSelectedRow(prev => {
      if (prev === key) return null;   // clicking same row toggles it off
      if (prev !== null) return null;  // clicking any other row just deselects
      return key;                      // nothing selected → select this row
    });
    setRowNoteMenu(null);
  }, []);

  const handleStartEditRow = useCallback((rowKey: string, row: Row) => {
    if (!row.id) return;
    setRowNoteMenu(null);
    const draft = draftEdits.get(row.id);
    const y = row.your;
    const a = row.adjuster;
    const initial: EditValues = {
      yDesc: draft?.yDesc ?? y?.description ?? '',
      aDesc: draft?.aDesc ?? a?.description ?? '',
      yQty: draft?.yQty ?? (y?.qty ?? ''),
      aQty: draft?.aQty ?? (a?.qty ?? ''),
      yRemove: draft?.yRemove ?? (y ? String(y.remove) : ''),
      aRemove: draft?.aRemove ?? (a ? String(a.remove) : ''),
      yReplace: draft?.yReplace ?? (y ? String(y.replace) : ''),
      aReplace: draft?.aReplace ?? (a ? String(a.replace) : ''),
      yTax: draft?.yTax ?? (y ? String(y.tax) : ''),
      aTax: draft?.aTax ?? (a ? String(a.tax) : ''),
      yOp: draft?.yOp ?? (y ? String(y.op) : ''),
      aOp: draft?.aOp ?? (a ? String(a.op) : ''),
      yTotal: draft?.yTotal ?? (y ? String(y.total) : ''),
      aTotal: draft?.aTotal ?? (a ? String(a.total) : ''),
    };
    editingRowIdRef.current = row.id;
    editingOriginalRef.current = { ...initial };
    editingValuesRef.current = { ...initial };
    setEditingValues(initial);
    setEditingRowKey(rowKey);
    setSelectedRow(rowKey);
  }, [draftEdits]);

  const handleCommitEdit = useCallback((rowId: string) => {
    if (!editingRowIdRef.current) return; // already handled by mousedown listener
    const values = editingValuesRef.current;
    const original = editingOriginalRef.current;
    const hasChanged = original
      ? (Object.keys(values) as (keyof EditValues)[]).some(k => values[k] !== original[k])
      : true;
    if (hasChanged) {
      pushSnapshot();
      const next = new Map(draftEditsRef.current);
      next.set(rowId, { ...values });
      draftEditsRef.current = next;
      setDraftEdits(next);
    }
    editingRowIdRef.current = null;
    setEditingRowKey(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    editingRowIdRef.current = null;
    editingOriginalRef.current = null;
    setEditingRowKey(null);
    setEditingValues(blankEditValues());
  }, []);

  const handleDiscardRowEdit = useCallback(() => {
    if (!rowNoteMenu?.row.id) return;
    pushSnapshot();
    const rowId = rowNoteMenu.row.id;
    const next = new Map(draftEditsRef.current);
    next.delete(rowId);
    draftEditsRef.current = next;
    setDraftEdits(next);
    if (rowId.startsWith('__new__')) {
      const nextIns = new Map(draftInsertsRef.current);
      nextIns.delete(rowId);
      draftInsertsRef.current = nextIns;
      setDraftInserts(nextIns);
    }
    if (editingRowKey === rowNoteMenu.rowKey) {
      editingRowIdRef.current = null;
      editingOriginalRef.current = null;
      setEditingRowKey(null);
      setEditingValues(blankEditValues());
    }
    setRowNoteMenu(null);
  }, [rowNoteMenu, editingRowKey]);

  const handleAddLineItemAbove = useCallback(() => {
    if (!rowNoteMenu) return;
    pushSnapshot();
    let insertBeforeItemId: string;
    let parentZoneTempId: string | undefined;
    let zoneCanonical: string;
    let zoneYours: string | null;
    let zoneAdjuster: string | null;
    if (rowNoteMenu.isZoneRow && rowNoteMenu.zoneId) {
      if (rowNoteMenu.zoneId.startsWith('__newzone__')) {
        const parentTempId = rowNoteMenu.zoneId.slice('__newzone__'.length);
        const parentIns = draftInsertsRef.current.get(parentTempId);
        if (!parentIns) return;
        insertBeforeItemId = parentIns.insertBeforeItemId;
        parentZoneTempId = parentTempId;
        zoneCanonical = parentIns.zoneCanonical;
        zoneYours = parentIns.zoneYours;
        zoneAdjuster = parentIns.zoneAdjuster;
      } else {
        const zone = zones.find(z => z.id === rowNoteMenu.zoneId);
        if (!zone) return;
        const firstReal = zone.items.find(i => i.id && !i.id.startsWith('__new__'));
        if (!firstReal?.id) return;
        insertBeforeItemId = firstReal.id;
        zoneCanonical = zone.canonicalName;
        zoneYours = zone.yourName;
        zoneAdjuster = zone.adjusterName;
      }
    } else {
      if (!rowNoteMenu.row.id) return;
      if (rowNoteMenu.row.id.startsWith('__new__')) {
        const zoneId = rowNoteMenu.rowKey.slice(0, rowNoteMenu.rowKey.lastIndexOf('-'));
        if (!zoneId.startsWith('__newzone__')) return;
        const parentTempId = zoneId.slice('__newzone__'.length);
        const parentIns = draftInsertsRef.current.get(parentTempId);
        if (!parentIns) return;
        insertBeforeItemId = parentIns.insertBeforeItemId;
        parentZoneTempId = parentTempId;
        zoneCanonical = parentIns.zoneCanonical;
        zoneYours = parentIns.zoneYours;
        zoneAdjuster = parentIns.zoneAdjuster;
      } else {
        const zoneId = rowNoteMenu.rowKey.slice(0, rowNoteMenu.rowKey.lastIndexOf('-'));
        const zone = zones.find(z => z.id === zoneId);
        if (!zone) return;
        insertBeforeItemId = rowNoteMenu.row.id;
        zoneCanonical = zone.canonicalName;
        zoneYours = zone.yourName;
        zoneAdjuster = zone.adjusterName;
      }
    }
    const tempId = `__new__${Math.random().toString(36).slice(2)}`;
    const ins: DraftInsert = { tempId, insertBeforeItemId, zoneCanonical, zoneYours, zoneAdjuster, isNewZone: false, parentZoneTempId };
    const nextIns = new Map(draftInsertsRef.current);
    nextIns.set(tempId, ins);
    draftInsertsRef.current = nextIns;
    setDraftInserts(nextIns);
    const nextEdits = new Map(draftEditsRef.current);
    nextEdits.set(tempId, blankEditValues());
    draftEditsRef.current = nextEdits;
    setDraftEdits(nextEdits);
    setRowNoteMenu(null);
  }, [rowNoteMenu, zones]);

  const handleAddZoneAbove = useCallback(() => {
    if (!rowNoteMenu) return;
    pushSnapshot();
    let firstRealItemId: string | undefined;
    if (rowNoteMenu.isZoneRow && rowNoteMenu.zoneId) {
      if (rowNoteMenu.zoneId.startsWith('__newzone__')) {
        const tempId = rowNoteMenu.zoneId.slice('__newzone__'.length);
        const existingIns = draftInsertsRef.current.get(tempId);
        if (!existingIns) return;
        firstRealItemId = existingIns.insertBeforeItemId;
      } else {
        const zone = zones.find(z => z.id === rowNoteMenu.zoneId);
        if (!zone) return;
        firstRealItemId = zone.items.find(i => i.id && !i.id.startsWith('__new__'))?.id;
      }
    } else {
      if (!rowNoteMenu.row.id || rowNoteMenu.row.id.startsWith('__new__')) return;
      const zoneId = rowNoteMenu.rowKey.slice(0, rowNoteMenu.rowKey.lastIndexOf('-'));
      const zone = zones.find(z => z.id === zoneId);
      if (!zone) return;
      firstRealItemId = zone.items.find(i => i.id)?.id;
    }
    if (!firstRealItemId) return;
    const tempId = `__new__${Math.random().toString(36).slice(2)}`;
    const ins: DraftInsert = { tempId, insertBeforeItemId: firstRealItemId, zoneCanonical: 'New Zone', zoneYours: 'New Zone', zoneAdjuster: null, isNewZone: true };
    const nextIns = new Map(draftInsertsRef.current);
    nextIns.set(tempId, ins);
    draftInsertsRef.current = nextIns;
    setDraftInserts(nextIns);
    const nextEdits = new Map(draftEditsRef.current);
    nextEdits.set(tempId, blankEditValues());
    draftEditsRef.current = nextEdits;
    setDraftEdits(nextEdits);
    setRowNoteMenu(null);
  }, [rowNoteMenu, zones]);

  const handleDeleteRow = useCallback(() => {
    if (!rowNoteMenu?.row.id || rowNoteMenu.row.id.startsWith('__new__')) return;
    const rowId = rowNoteMenu.row.id;
    const next = new Map(draftEditsRef.current);
    next.set(rowId, { ...blankEditValues(), deleted: true });
    draftEditsRef.current = next;
    setDraftEdits(next);
    setRowNoteMenu(null);
  }, [rowNoteMenu]);

  const handleDeleteZoneClick = useCallback(() => {
    if (!rowNoteMenu) return;
    const zoneId = rowNoteMenu.isZoneRow && rowNoteMenu.zoneId
      ? rowNoteMenu.zoneId
      : rowNoteMenu.rowKey.slice(0, rowNoteMenu.rowKey.lastIndexOf('-'));
    if (zoneId.startsWith('__newzone__')) {
      pushSnapshot();
      const parentTempId = zoneId.slice('__newzone__'.length);
      const nextIns = new Map(draftInsertsRef.current);
      const nextEdits = new Map(draftEditsRef.current);
      for (const [tid, ins] of nextIns.entries()) {
        if (tid === parentTempId || ins.parentZoneTempId === parentTempId) {
          nextIns.delete(tid);
          nextEdits.delete(tid);
        }
      }
      draftInsertsRef.current = nextIns;
      setDraftInserts(nextIns);
      draftEditsRef.current = nextEdits;
      setDraftEdits(nextEdits);
      setRowNoteMenu(null);
      return;
    }
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    const rowIds = zone.items.filter(i => i.id && !i.id.startsWith('__new__')).map(i => i.id!);
    setDeleteZoneConfirm({ zoneName: zone.canonicalName, rowIds });
    setRowNoteMenu(null);
  }, [rowNoteMenu, zones]);

  const handleDeleteZoneConfirm = useCallback(() => {
    if (!deleteZoneConfirm) return;
    pushSnapshot();
    const next = new Map(draftEditsRef.current);
    for (const rowId of deleteZoneConfirm.rowIds) {
      next.set(rowId, { ...blankEditValues(), deleted: true });
    }
    draftEditsRef.current = next;
    setDraftEdits(next);
    setDeleteZoneConfirm(null);
  }, [deleteZoneConfirm]);

  // Pure validation — returns error strings, no side-effects
  const collectDraftErrors = useCallback((): string[] => {
    const currentDrafts = draftEditsRef.current;
    const errors: string[] = [];
    let lineNum = 0;
    for (const zone of zonesRef.current) {
      for (const row of zone.items) {
        lineNum++;
        if (!row.id || row.id.startsWith('__new__')) continue;
        const draft = currentDrafts.get(row.id);
        if (!draft) continue;
        const checkSide = (label: string, desc: string, qty: string, totalRaw: string) => {
          const hasDesc = desc.trim().length > 0;
          const hasQty = qty.trim().length > 0;
          const hasTotal = totalRaw.trim().length > 0 && isFinite(parseFloat(totalRaw));
          const filled = [hasDesc, hasQty, hasTotal].filter(Boolean).length;
          if (filled === 0 || filled === 3) return;
          const missing: string[] = [];
          if (!hasDesc) missing.push('Description');
          if (!hasQty) missing.push('Qty');
          if (!hasTotal) missing.push('Total');
          errors.push(`Line ${lineNum} (${label}) is missing ${missing.join(' and ')}. Please ensure it has a Description, Qty, and Total to save.`);
        };
        checkSide('your estimate', draft.yDesc, draft.yQty, draft.yTotal);
        checkSide("adjuster's estimate", draft.aDesc, draft.aQty, draft.aTotal);
      }
    }
    return errors;
  }, []);

  // Pure save — no validation; assumes caller already validated
  const executeSaveDraft = useCallback(async (): Promise<boolean> => {
    const currentDrafts = draftEditsRef.current;
    const currentInserts = draftInsertsRef.current;
    const currentZoneRenames = draftZoneNamesRef.current;
    const currentAdjusterZoneRenames = draftAdjusterZoneNamesRef.current;
    const currentMoves = draftMovesRef.current;
    if (!comparisonId || (currentDrafts.size === 0 && currentZoneRenames.size === 0 && currentAdjusterZoneRenames.size === 0 && currentMoves.size === 0) || savingDraft) return false;
    setSavingDraft(true);
    try {
      await fetch(`/api/comparisons/${comparisonId}/versions`, { method: 'POST' });
      const edits = Array.from(currentDrafts.entries())
        .filter(([itemId, v]) => !itemId.startsWith('__new__') && !v.deleted)
        .map(([itemId, v]) => {
          const yClear = v.yTotal === '';
          const aClear = v.aTotal === '';
          return {
            itemId,
            fields: {
              descriptionYours: v.yDesc || null,
              descriptionAdjuster: v.aDesc || null,
              qtyYours: v.yQty || null,
              qtyAdjuster: v.aQty || null,
              removeYours:    yClear ? null : (v.yRemove  !== '' ? parseFloat(v.yRemove)  : null),
              removeAdjuster: aClear ? null : (v.aRemove  !== '' ? parseFloat(v.aRemove)  : null),
              replaceYours:   yClear ? null : (v.yReplace !== '' ? parseFloat(v.yReplace) : null),
              replaceAdjuster:aClear ? null : (v.aReplace !== '' ? parseFloat(v.aReplace) : null),
              taxYours:       yClear ? null : (v.yTax     !== '' ? parseFloat(v.yTax)     : null),
              taxAdjuster:    aClear ? null : (v.aTax     !== '' ? parseFloat(v.aTax)     : null),
              opYours:        yClear ? null : (v.yOp      !== '' ? parseFloat(v.yOp)      : null),
              opAdjuster:     aClear ? null : (v.aOp      !== '' ? parseFloat(v.aOp)      : null),
              totalYours:     yClear ? null : parseFloat(v.yTotal),
              totalAdjuster:  aClear ? null : parseFloat(v.aTotal),
            },
          };
        });
      const inserts = Array.from(currentDrafts.entries())
        .filter(([itemId, v]) => itemId.startsWith('__new__') && !v.deleted)
        .map(([tempId, v]) => {
          const ins = currentInserts.get(tempId);
          if (!ins) return null;
          const yClear = v.yTotal === '';
          const aClear = v.aTotal === '';
          return {
            insertBeforeItemId: ins.insertBeforeItemId,
            zoneCanonical: ins.zoneCanonical,
            zoneYours: ins.zoneYours,
            zoneAdjuster: ins.zoneAdjuster,
            fields: {
              descriptionYours: v.yDesc || null,
              descriptionAdjuster: v.aDesc || null,
              qtyYours: v.yQty || null,
              qtyAdjuster: v.aQty || null,
              removeYours:    yClear ? null : (v.yRemove  !== '' ? parseFloat(v.yRemove)  : null),
              removeAdjuster: aClear ? null : (v.aRemove  !== '' ? parseFloat(v.aRemove)  : null),
              replaceYours:   yClear ? null : (v.yReplace !== '' ? parseFloat(v.yReplace) : null),
              replaceAdjuster:aClear ? null : (v.aReplace !== '' ? parseFloat(v.aReplace) : null),
              taxYours:       yClear ? null : (v.yTax     !== '' ? parseFloat(v.yTax)     : null),
              taxAdjuster:    aClear ? null : (v.aTax     !== '' ? parseFloat(v.aTax)     : null),
              opYours:        yClear ? null : (v.yOp      !== '' ? parseFloat(v.yOp)      : null),
              opAdjuster:     aClear ? null : (v.aOp      !== '' ? parseFloat(v.aOp)      : null),
              totalYours:     yClear ? null : parseFloat(v.yTotal),
              totalAdjuster:  aClear ? null : parseFloat(v.aTotal),
            },
          };
        }).filter((x): x is NonNullable<typeof x> => x !== null);
      const deletions = Array.from(currentDrafts.entries())
        .filter(([, v]) => !!v.deleted)
        .map(([id]) => id);
      const zoneRenames = Array.from(currentZoneRenames.entries())
        .map(([zoneId, newCanonical]) => {
          const zone = zonesRef.current.find(z => z.id === zoneId);
          if (!zone) return null;
          return { oldCanonical: zone.canonicalName, newCanonical };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const zoneAdjusterRenames = Array.from(currentAdjusterZoneRenames.entries())
        .map(([zoneId, newAdjusterName]) => {
          const zone = zonesRef.current.find(z => z.id === zoneId);
          if (!zone) return null;
          return { canonical: zone.canonicalName, newAdjusterName };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const zoneMoves = Array.from(currentMoves.entries()).map(([itemId, targetZoneId]) => ({ itemId, targetZoneId }));
      const res = await fetch(`/api/comparisons/${comparisonId}/versions/inline-edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits, inserts, deletions, zoneRenames, zoneAdjusterRenames, zoneMoves }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to save version.');
      }
      const data = await res.json();
      if (data.version?.id) {
        await loadVersionZones(data.version.id);
        await fetchVersions();
      }
      const emptyEdits = new Map<string, EditValues>();
      draftEditsRef.current = emptyEdits;
      setDraftEdits(emptyEdits);
      const emptyInserts = new Map<string, DraftInsert>();
      draftInsertsRef.current = emptyInserts;
      setDraftInserts(emptyInserts);
      const emptyZoneNames = new Map<string, string>();
      draftZoneNamesRef.current = emptyZoneNames;
      setDraftZoneNames(emptyZoneNames);
      const emptyAdjZoneNames = new Map<string, string>();
      draftAdjusterZoneNamesRef.current = emptyAdjZoneNames;
      setDraftAdjusterZoneNames(emptyAdjZoneNames);
      const emptyMoves = new Map<string, string>();
      draftMovesRef.current = emptyMoves;
      setDraftMoves(emptyMoves);
      undoStackRef.current = [];
      setUndoStack([]);
      redoStackRef.current = [];
      setRedoStack([]);
      return true;
    } catch (err) {
      console.error('[inline-edit] Failed to save draft as version:', err);
      return false;
    } finally {
      setSavingDraft(false);
    }
  }, [comparisonId, savingDraft, loadVersionZones, fetchVersions]);

  // Combined validate + save — used only by the unsaved-navigation guard
  const handleSaveDraftAsVersion = useCallback(async (): Promise<boolean> => {
    const errors = collectDraftErrors();
    if (errors.length > 0) { setSaveDraftErrors(errors); return false; }
    return executeSaveDraft();
  }, [collectDraftErrors, executeSaveDraft]);

  const navigateGuarded = useCallback((cb: () => void) => {
    if (draftEdits.size > 0 || draftZoneNames.size > 0 || draftAdjusterZoneNames.size > 0 || draftMoves.size > 0) {
      unsavedGuardCallbackRef.current = cb;
      setUnsavedGuardOpen(true);
    } else {
      cb();
    }
  }, [draftEdits.size, draftZoneNames.size, draftAdjusterZoneNames.size, draftMoves.size]);

  const toggleCostColumn = useCallback((key: string) => {
    setVisibleCosts(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }, []);

  const filterCount = (zoneFilter ? 1 : 0) + (minDiff > 0 ? 1 : 0);

  /* Compute counts and totals */
  const stats = useMemo(() => {
    const allItems = zones.flatMap(z => z.items);
    const counts = { match: 0, match_unverified: 0, modified: 0, missing: 0, added: 0 };
    let yourTotal = 0, adjTotal = 0;
    allItems.forEach(r => {
      counts[r.status]++;
      if (r.your) yourTotal += r.your.total;
      if (r.adjuster) adjTotal += r.adjuster.total;
    });

    if (allItems.length === 0 && comparison) {
      const comparisonYourTotal = comparison.yourEstimateTotal ?? 0;
      const comparisonAdjusterTotal = comparison.adjusterEstimateTotal ?? 0;
      const comparisonGap = comparison.totalGap ?? (comparisonYourTotal - comparisonAdjusterTotal);

      return {
        counts: {
          match: comparison.matchCount,
          match_unverified: 0,
          modified: comparison.modifiedCount,
          missing: comparison.missingCount,
          added: comparison.addedCount,
        },
        yourTotal: comparisonYourTotal,
        adjTotal: comparisonAdjusterTotal,
        gap: comparisonGap,
        total: comparison.matchCount + comparison.modifiedCount + comparison.missingCount + comparison.addedCount,
      };
    }

    const gap = yourTotal - adjTotal;
    return { counts, yourTotal, adjTotal, gap, total: allItems.length };
  }, [comparison, zones]);

  const gapAbsolute = Math.abs(stats.gap);
  const isYourEstimateLower = stats.gap < 0;
  const totalGapPrefix = stats.gap > 0 ? '-' : stats.gap < 0 ? '+' : '';
  const gapDirectionText =
    stats.gap === 0 ? 'Estimates are equal' : isYourEstimateLower ? 'Adjuster estimate is higher' : 'Adjuster estimate is lower';
  const handleLineItemNoteNavigate = useCallback((lineItemId: string) => {
    let targetZoneId: string | null = null;
    let targetRowKey: string | null = null;

    for (const zone of zonesWithInserts) {
      const visibleItems = zone.items.filter(row => isRowVisible(row, zone.id));
      const rowIndex = visibleItems.findIndex(row =>
        row.id === lineItemId || row.originalLineItemId === lineItemId
      );
      if (rowIndex !== -1) {
        targetZoneId = zone.id;
        targetRowKey = `${zone.id}-${rowIndex}`;
        break;
      }
    }

    if (!targetZoneId || !targetRowKey) return;

    setCollapsedZones(prev => {
      if (!prev.has(targetZoneId!)) return prev;
      const next = new Set(prev);
      next.delete(targetZoneId!);
      return next;
    });
    setSelectedRow(targetRowKey);
    setRowNoteMenu(null);

    setFlashedRowKey(targetRowKey);
    setTimeout(() => setFlashedRowKey(null), 1200);

    let attempts = 0;
    const maxAttempts = 6;
    const scrollToRow = () => {
      const rowEl = document.querySelector(`tr[data-row-key="${targetRowKey}"]`) as HTMLTableRowElement | null;
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return;
      }
      if (attempts < maxAttempts) {
        attempts += 1;
        requestAnimationFrame(scrollToRow);
      }
    };
    requestAnimationFrame(scrollToRow);
  }, [zonesWithInserts, isRowVisible]);

  /* All item IDs present in the current zones (no filter) — used to detect version-deleted items in notes */
  const activeItemIds = useMemo((): Set<string> => {
    const set = new Set<string>();
    for (const zone of zones) {
      for (const row of zone.items) {
        if (row.id) set.add(row.id);
        if (row.originalLineItemId) set.add(row.originalLineItemId);
      }
    }
    return set;
  }, [zones]);

  /* Live row-number map — keyed on row.id AND row.originalLineItemId for cross-version lookup */
  const rowNumberMap = useMemo((): Map<string, number> => {
    const map = new Map<string, number>();
    let n = 0;
    for (const zone of zonesWithInserts) {
      for (const row of zone.items) {
        if (!isRowVisible(row, zone.id)) continue;
        n++;
        if (row.id) map.set(row.id, n);
        if (row.originalLineItemId && row.originalLineItemId !== row.id) {
          map.set(row.originalLineItemId, n);
        }
      }
    }
    return map;
  }, [zonesWithInserts, isRowVisible]);

  /* Zone-level gaps */
  const zoneGaps = useMemo(() => {
    return zones.map(z => {
      let yt = 0, at = 0;
      z.items.forEach(r => { if (r.your) yt += r.your.total; if (r.adjuster) at += r.adjuster.total; });
      return { name: z.canonicalName, gap: yt - at };
    });
  }, [zones]);

  const maxGap = Math.max(...zoneGaps.map(z => Math.abs(z.gap)), 1);
  const hasSelection = selectedRow !== null;

  const printZones = useMemo(() => {
    return zonesWithInserts
      .map(zone => ({
        zone,
        items: zone.items.filter(row => isRowVisible(row, zone.id)),
      }))
      .filter(entry => entry.items.length > 0);
  }, [zonesWithInserts, isRowVisible]);

  const handleGateExitRequest = useCallback(() => { setGateExitConfirmOpen(true); }, []);

  const handleGateExitConfirm = useCallback(async () => {
    if (gateExiting) return;
    setGateExiting(true);
    try { await fetch(`/api/comparisons/${comparisonId}`, { method: 'DELETE' }); } catch { /* silent */ }
    router.push('/app/comparisons');
  }, [comparisonId, gateExiting, router]);

  const gateExitDialog = gateExitConfirmOpen ? (
    <div className={styles.unsavedGuardOverlay} onClick={() => { if (!gateExiting) setGateExitConfirmOpen(false); }}>
      <div className={styles.unsavedGuardDialog} onClick={(e) => e.stopPropagation()}>
        <p className={styles.unsavedGuardTitle}>Exit and delete comparison?</p>
        <p className={styles.unsavedGuardBody}>
          Leaving now will <strong>permanently delete</strong>{' '}this comparison. You&apos;ll need to start a new one.
        </p>
        <div className={styles.unsavedGuardActions}>
          <button className={styles.unsavedGuardSaveBtn} style={{ background: 'var(--danger-color, #dc2626)', color: '#fff' }} disabled={gateExiting} onClick={handleGateExitConfirm}>
            {gateExiting ? 'Deleting…' : 'Yes, delete and exit'}
          </button>
          <button className={styles.unsavedGuardCancelBtn} disabled={gateExiting} onClick={() => setGateExitConfirmOpen(false)}>Cancel</button>
        </div>
      </div>
    </div>
  ) : null;

  if (comparison?.status === 'AWAITING_ZONE_REVIEW' && comparisonId) {
    return (
      <>
        <ZoneReview
          comparisonId={comparisonId}
          initialE1Zones={n2ReviewZones?.e1 ?? []}
          initialE2Zones={n2ReviewZones?.e2 ?? []}
          onConfirmed={async ({ reEntry }) => {
            if (reEntry) {
              // Pipeline is already past the zone-review gate and blocked at
              // the match-review gate. Skip the PROCESSING spinner entirely:
              // fetch existing match data and show MatchReview immediately.
              setN2ReviewZones(null);
              try {
                const mrRes = await fetch(`/api/comparisons/${comparisonId}/match-review`);
                if (mrRes.ok) {
                  const mrData = await mrRes.json() as { pairs: MatchPair[]; unmatchedE1: string[]; unmatchedE2: string[] };
                  setN2MatchData(mrData);
                }
              } catch {
                // non-fatal — MatchReview will show empty lists
              }
              setComparison(prev => prev ? { ...prev, status: 'AWAITING_MATCH_REVIEW' } : prev);
            } else {
              setComparison(prev => prev ? { ...prev, status: 'PROCESSING' } : prev);
              setN2ReviewZones(null);
              setIsAwaitingNextPass(true);
            }
          }}
          onExit={handleGateExitRequest}
        />
        {gateExitDialog}
      </>
    );
  }

  if (isAwaitingNextPass && comparison?.status === 'PROCESSING') {
    return (
      <>
        <MobileAppBar title={comparison?.name ?? 'Comparison'} />
        <TrialBanner />
        <div className={styles.n2LoadingOverlay}>
          <div className={styles.n2LoadingSpinner} />
          <h2 className={styles.n2LoadingHeadline}>Matching zones across estimates…</h2>
          <div className={styles.n2ProgressWrap}>
            <div className={styles.n2ProgressTrack}>
              <div className={styles.n2ProgressFill} style={{ width: `${awaitingPercent}%` }} />
            </div>
            <div className={styles.n2ProgressMeta}>
              <span>{Math.round(awaitingPercent)}%</span>
              <span>{awaitingElapsed < 60 ? `${awaitingElapsed}s elapsed` : `${Math.floor(awaitingElapsed / 60)}m ${awaitingElapsed % 60}s elapsed`}</span>
            </div>
          </div>
          <p className={styles.n2LoadingDisclaimer}>
            Your confirmed zones are being cross-referenced to pair matching rooms and areas between both estimates. This typically takes 1–3 minutes.
          </p>
          <p className={styles.n2LoadingNote}>
            Larger estimates may take up to 10–15 minutes. You&apos;ll have a chance to review and confirm the matched zones before line items are extracted.
          </p>
        </div>
      </>
    );
  }

  if (comparison?.status === 'AWAITING_MATCH_REVIEW' && comparisonId) {
    return (
      <>
        <MatchReview
          comparisonId={comparisonId}
          initialPairs={n2MatchData?.pairs ?? []}
          initialUnmatchedE1={n2MatchData?.unmatchedE1 ?? []}
          initialUnmatchedE2={n2MatchData?.unmatchedE2 ?? []}
          onConfirmed={() => {
            setComparison(prev => prev ? { ...prev, status: 'PROCESSING' } : prev);
            setN2MatchData(null);
            setIsAwaitingExtractPhase(true);
          }}
          onBack={async () => {
            try {
              const zrRes = await fetch(`/api/comparisons/${comparisonId}/zone-review`);
              if (zrRes.ok) {
                const zrData = await zrRes.json() as { e1Zones: ReviewZone[]; e2Zones: ReviewZone[] };
                setN2ReviewZones({ e1: zrData.e1Zones, e2: zrData.e2Zones });
              }
            } catch {
              // non-fatal — ZoneReview will show the last known zones or empty lists
            }
            setN2MatchData(null);
            setComparison(prev => prev ? { ...prev, status: 'AWAITING_ZONE_REVIEW' } : prev);
          }}
          onExit={handleGateExitRequest}
        />
        {gateExitDialog}
      </>
    );
  }

  if (comparison?.status === 'AWAITING_LINE_ITEM_REVIEW' && comparisonId) {
    return (
      <>
        <LineItemReview
          comparisonId={comparisonId}
          initialYours={n3LineItemData?.yours ?? []}
          initialAdj={n3LineItemData?.adjuster ?? []}
          yoursTotal={n3LineItemData?.yoursTotal ?? 0}
          adjusterTotal={n3LineItemData?.adjusterTotal ?? 0}
          onConfirmed={() => {
            setComparison(prev => prev ? { ...prev, status: 'PROCESSING' } : prev);
            setN3LineItemData(null);
            setIsAwaitingLineItemPhase(true);
          }}
          onExit={handleGateExitRequest}
        />
        {gateExitDialog}
      </>
    );
  }

  if (isAwaitingExtractPhase && comparison?.status === 'PROCESSING') {
    return (
      <>
        <MobileAppBar title={comparison?.name ?? 'Comparison'} />
        <TrialBanner />
        <div className={styles.n2LoadingOverlay}>
          <div className={styles.n2LoadingSpinner} />
          <h2 className={styles.n2LoadingHeadline}>Extracting and matching line items…</h2>
          <div className={styles.n2ProgressWrap}>
            <div className={styles.n2ProgressTrack}>
              <div className={styles.n2ProgressFill} style={{ width: `${awaitingPercent}%` }} />
            </div>
            <div className={styles.n2ProgressMeta}>
              <span>{Math.round(awaitingPercent)}%</span>
              <span>{awaitingElapsed < 60 ? `${awaitingElapsed}s elapsed` : `${Math.floor(awaitingElapsed / 60)}m ${awaitingElapsed % 60}s elapsed`}</span>
            </div>
          </div>
          <p className={styles.n2LoadingDisclaimer}>
            Line items are being read from both estimates, organized by zone, and matched against each other. This is typically the longest step in the process.
          </p>
          <p className={styles.n2LoadingNote}>
            Depending on the size of your estimates, this step can take anywhere from 2–15 minutes. Please keep this tab open — results will load automatically when ready.
          </p>
        </div>
      </>
    );
  }

  if (isAwaitingLineItemPhase && comparison?.status === 'PROCESSING') {
    return (
      <>
        <MobileAppBar title={comparison?.name ?? 'Comparison'} />
        <TrialBanner />
        <div className={styles.n2LoadingOverlay}>
          <div className={styles.n2LoadingSpinner} />
          <h2 className={styles.n2LoadingHeadline}>Scoring and finalizing line item matches…</h2>
          <div className={styles.n2ProgressWrap}>
            <div className={styles.n2ProgressTrack}>
              <div className={styles.n2ProgressFill} style={{ width: `${awaitingPercent}%` }} />
            </div>
            <div className={styles.n2ProgressMeta}>
              <span>{Math.round(awaitingPercent)}%</span>
              <span>{awaitingElapsed < 60 ? `${awaitingElapsed}s elapsed` : `${Math.floor(awaitingElapsed / 60)}m ${awaitingElapsed % 60}s elapsed`}</span>
            </div>
          </div>
          <p className={styles.n2LoadingDisclaimer}>
            Each line item is being scored and ranked to determine matches, partial matches, and discrepancies between the two estimates.
          </p>
          <p className={styles.n2LoadingNote}>
            This final step usually completes within 2–5 minutes. Your full comparison results will load automatically when ready.
          </p>
        </div>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <MobileAppBar title="Comparison" />
        <TrialBanner />
        <div className={styles.n2LoadingOverlay}>
          <div className={styles.n2LoadingSpinner} />
        </div>
      </>
    );
  }

  return (
    <>
      <MobileAppBar title={comparison?.name ?? 'Comparison'} />
      <TrialBanner />
      <div className={styles.content}>
        <div className={styles.printHeader}>
          <div className={styles.printHeaderTitle}>ScopeSplit — Estimate Comparison</div>
          <div className={styles.printHeaderMeta}>
            <span><strong>Your estimate:</strong> {comparison?.yourEstimateFilename ?? '—'}</span>
            <span><strong>Adjuster&apos;s estimate:</strong> {comparison?.adjusterEstimateFilename ?? '—'}</span>
            <span><strong>Generated:</strong> {printDate}</span>
          </div>
        </div>
        <div className={styles.header}>
          {isRenamingHeader ? (
            <form
              className={styles.headerRenameForm}
              onSubmit={(e) => { e.preventDefault(); void handleRenameHeader(); }}
            >
              <input
                className={styles.headerRenameInput}
                value={renameHeaderValue}
                onChange={(e) => setRenameHeaderValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setIsRenamingHeader(false); }}
                placeholder="Enter comparison name..."
                autoFocus
                maxLength={200}
                disabled={renameHeaderSaving}
              />
            </form>
          ) : (
            <h1>{comparison?.name ?? 'Comparison'}</h1>
          )}
          <div className={styles.pageActions} ref={pageMenuRef}>
            {isRenamingHeader ? (
              <div className={styles.headerRenameActions}>
                <button
                  className={styles.headerRenameOkBtn}
                  onClick={() => void handleRenameHeader()}
                  disabled={renameHeaderSaving || !renameHeaderValue.trim()}
                  aria-label="Save name"
                >
                  {renameHeaderSaving ? <span className={styles.miniSpinner} /> : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polyline points="1,7 5,11 13,3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
                <button
                  className={styles.headerRenameCxBtn}
                  onClick={() => setIsRenamingHeader(false)}
                  disabled={renameHeaderSaving}
                  aria-label="Cancel rename"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
              </div>
            ) : (
              <>
                <button
                  className={styles.pageMoreBtn}
                  onClick={() => { setPageMenuOpen(prev => !prev); setConfirmDelete(false); }}
                  aria-label="More options"
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <span className={styles.miniSpinner} />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 16 16"><circle cx="8" cy="3" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="13" r="1.2" fill="currentColor" /></svg>
                  )}
                </button>
                {pageMenuOpen && (
                  <div className={styles.pageDropMenu}>
                    {confirmDelete ? (
                      <>
                        <span className={styles.dropConfirmText}>Delete this comparison?</span>
                        <span className={styles.dropConfirmSubtext}>This will not restore your monthly comparison count.</span>
                        <button className={styles.dropItemDanger} onClick={handleDeleteComparison}>Yes, delete</button>
                        <button className={styles.dropItem} onClick={() => setConfirmDelete(false)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className={styles.dropItem} onClick={() => { setPageMenuOpen(false); setIsRenamingHeader(true); setRenameHeaderValue(comparison?.name ?? ''); }}>Rename</button>
                        <button className={styles.dropItemDanger} onClick={() => setConfirmDelete(true)}>Delete</button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {isLoading ? <div className={styles.stateBanner}>Loading comparison data...</div> : null}

        {loadError ? (
          <div className={`${styles.stateBanner} ${styles.stateBannerError}`}>
            {loadError} Showing fallback preview data.
          </div>
        ) : null}

        {comparison?.status === 'PROCESSING' ? (
          <div className={styles.stateBanner}>
            Comparison is processing. Metrics and line items will populate as extraction completes.
          </div>
        ) : null}

        {comparison?.status === 'COMPLETED' ? (
          <div className={`${styles.stateBanner} ${styles.stateBannerSuccess}`}>
            Comparison completed successfully.
          </div>
        ) : null}

        {comparison?.status === 'FAILED' ? (
          <div className={`${styles.stateBanner} ${styles.stateBannerError}`}>
            Comparison failed{comparison.errorMessage ? `: ${comparison.errorMessage}` : '.'}
          </div>
        ) : null}

        {/* ── Summary Dashboard ── */}
        <div className={styles.dashboard}>
          <div className={styles.dashTotals}>
            <div className={styles.dashTotalCol}>
              <p className={styles.dashLabel}>Your estimate</p>
              <p className={styles.dashValue}>${fmt(stats.yourTotal)}</p>
              <p className={styles.dashSub}>{stats.total - stats.counts.added} line items</p>
            </div>
            <div className={styles.dashTotalCol}>
              <p className={styles.dashLabel}>Adjuster&apos;s estimate</p>
              <p className={styles.dashValue}>${fmt(stats.adjTotal)}</p>
              <p className={styles.dashSub}>{stats.total - stats.counts.missing} line items</p>
            </div>
            <div className={styles.dashTotalCol}>
              <p className={styles.dashLabel}>Total gap</p>
              <p className={`${styles.dashValue} ${stats.gap === 0 ? '' : isYourEstimateLower ? styles.dashSuccess : styles.dashDanger}`}>
                {totalGapPrefix}${fmt(gapAbsolute)}
              </p>
              <p className={styles.dashSub}>{gapDirectionText}</p>
            </div>
          </div>

          <div className={styles.dashStatus}>
            <p className={styles.dashStatusTitle}>Line item breakdown</p>
            <div className={styles.dashStatusGrid}>
              <div className={styles.dashStat}><span className={`${styles.dashDot} ${styles.dotMatch}`} /><span className={styles.dashStatCount}>{stats.counts.match}</span><span className={styles.dashStatLabel}> {statusLabel.match.toLowerCase()}</span></div>
              <div className={styles.dashStat}><span className={`${styles.dashDot} ${styles.dotMatchUnverified}`} /><span className={styles.dashStatCount}>{stats.counts.match_unverified}</span><span className={styles.dashStatLabel}> {statusLabel.match_unverified.toLowerCase()}</span></div>
              <div className={styles.dashStat}><span className={`${styles.dashDot} ${styles.dotModified}`} /><span className={styles.dashStatCount}>{stats.counts.modified}</span><span className={styles.dashStatLabel}> {statusLabel.modified.toLowerCase()}</span></div>
              <div className={styles.dashStat}><span className={`${styles.dashDot} ${styles.dotMissing}`} /><span className={styles.dashStatCount}>{stats.counts.missing}</span><span className={styles.dashStatLabel}> {statusLabel.missing.toLowerCase()}</span></div>
              <div className={styles.dashStat}><span className={`${styles.dashDot} ${styles.dotAdded}`} /><span className={styles.dashStatCount}>{stats.counts.added}</span><span className={styles.dashStatLabel}> {statusLabel.added.toLowerCase()}</span></div>
            </div>
          </div>

          <div className={styles.dashZones}>
            <p className={styles.dashZonesTitle}>Gap by zone</p>
            {zoneGaps.map(z => (
              <div key={z.name} className={styles.zoneRow}>
                <div className={styles.zoneName}>{z.name}</div>
                <div className={styles.zoneTrack}>
                  <div
                    className={`${styles.zoneFill} ${z.gap > 0 ? styles.zoneFillDanger : styles.zoneFillSuccess}`}
                    style={{ width: `${(Math.abs(z.gap) / maxGap) * 100}%` }}
                  />
                </div>
                <div className={`${styles.zoneAmount} ${z.gap > 0 ? styles.dashDanger : styles.dashSuccess}`}>
                  {z.gap > 0 ? '-' : z.gap < 0 ? '+' : ''}{fmt(Math.abs(z.gap))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Toolbar ── */}
        <div className={styles.toolbarShell}>

          {/* Row 1: Status Filters */}
          <div className={styles.toolbarRow1}>
            <div className={styles.pillGroup}>
              {(['match', 'match_unverified', 'modified', 'missing', 'added'] as StatusFilter[]).map(f => (
                <button
                  key={f}
                  className={`${styles.pill} ${styles[`pill_${f}`]} ${activeFilters.has(f) ? styles.pillActive : ''}`}
                  onClick={() => toggleFilter(f)}
                >
                  <span className={styles.pillDot} />
                  {statusLabel[f]}
                  <span className={styles.pillCount}>{stats.counts[f]}</span>
                </button>
              ))}
            </div>
            <button className={`${styles.discrepLink} ${styles.tbHideMobile}`} onClick={handleDiscrepancies}>
              {activeFilters.size === 5 ? 'Discrepancies only' : 'Show all'}
            </button>
            <div className={styles.toolbarRow1Right}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search descriptions..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button
                className={`${styles.filtersToggleBtn} ${filtersOpen ? styles.filtersToggleBtnActive : ''}`}
                onClick={() => { setFiltersOpen(prev => !prev); setColumnsOpen(false); }}
              >
                Filters {filterCount > 0 && (
                  <span
                    className={styles.filtersClearBadge}
                    onClick={(e) => { e.stopPropagation(); setZoneFilter(''); setMinDiff(0); }}
                    title="Clear filters"
                  >{filterCount}&thinsp;&times;</span>
                )}
              </button>
              <button
                className={`${styles.filtersToggleBtn} ${columnsOpen ? styles.filtersToggleBtnActive : ''}`}
                onClick={() => { setColumnsOpen(prev => !prev); setFiltersOpen(false); }}
              >
                Columns {visibleCosts.length > 0 && (
                  <span
                    className={styles.filtersClearBadge}
                    onClick={(e) => { e.stopPropagation(); setVisibleCosts([]); }}
                    title="Clear columns"
                  >{visibleCosts.length}&thinsp;&times;</span>
                )}
              </button>
            </div>
          </div>

          {/* Row 2: Draft Controls (left) + Permanent Actions (right) */}
          <div className={styles.toolbarRow2}>
            <div className={styles.toolbarDraftGroup}>
              {(draftEdits.size > 0 || draftZoneNames.size > 0 || draftAdjusterZoneNames.size > 0 || draftInserts.size > 0 || draftMoves.size > 0) && (
                <button className={styles.undoRedoResetBtn} title="Discard all changes" disabled={savingDraft} onClick={handleResetAllChanges}>Reset all</button>
              )}
              {(draftEdits.size > 0 || draftZoneNames.size > 0 || draftAdjusterZoneNames.size > 0 || draftInserts.size > 0 || draftMoves.size > 0) && (
                <button
                  className={styles.saveDraftBtn}
                  onClick={() => {
                    const errs = collectDraftErrors();
                    if (errs.length > 0) { setSaveDraftErrors(errs); }
                    else { setShowSaveConfirm(true); }
                  }}
                  disabled={savingDraft}
                >
                  {(() => {
                    const total = draftEdits.size + draftZoneNames.size + draftAdjusterZoneNames.size + draftInserts.size + draftMoves.size;
                    return savingDraft ? 'Saving...' : `Save ${total} change${total !== 1 ? 's' : ''} as new version`;
                  })()}
                </button>
              )}
            </div>
            <div className={styles.toolbarActionsGroup}>
              {versions.length > 0 && (
                <div className={styles.versionHistoryWrap} ref={versionHistoryRef}>
                  <button
                    className={styles.versionHistoryBtn}
                    onClick={() => setVersionHistoryOpen(prev => !prev)}
                    disabled={versionLoading}
                  >
                    {versionLoading ? 'Loading...' : `v${versions.find(v => v.id === activeVersionId)?.versionNumber ?? '—'}`}
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l4 4 4-4" /></svg>
                  </button>
                  {versionHistoryOpen && (
                    <div className={styles.versionHistoryDropdown}>
                      <div className={styles.versionHistoryTitle}>Edit History</div>
                      {versions.map(v => (
                        <div
                          key={v.id}
                          className={`${styles.versionHistoryItem} ${v.id === activeVersionId ? styles.versionHistoryItemActive : ''}`}
                        >
                          <button
                            className={styles.versionHistoryItemBtn}
                            onClick={() => navigateGuarded(() => { void activateVersion(v.id); })}
                            disabled={versionLoading}
                          >
                            <span className={styles.versionHistoryItemLabel}>
                              <strong>v{v.versionNumber}</strong> — {v.label}
                            </span>
                            {v.editPrompt && (
                              <span className={styles.versionHistoryItemPrompt}>{v.editPrompt}</span>
                            )}
                            <span className={styles.versionHistoryItemDate}>
                              {new Date(v.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </span>
                          </button>
                          {versions.length > 1 && v.versionNumber !== 1 && (
                            <button
                              className={styles.versionDeleteBtn}
                              onClick={(e) => { e.stopPropagation(); setVersionDeleteConfirm(v.id); }}
                              disabled={versionLoading}
                              aria-label={`Delete version ${v.versionNumber}`}
                              title="Delete this version"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {versionError && (
                    <p className={styles.versionErrorMsg}>{versionError}</p>
                  )}
                </div>
              )}
              <button className={styles.editEntriesBtn} onClick={() => setLlmEditOpen(true)}>
                LLM Edit
              </button>
              <button className={styles.summaryBtn} onClick={() => void handleSummaryConfirmOpen(false)} disabled={summaryLoading}>
                <svg className={styles.summaryBtnIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <span className={styles.btnLabel}>{summaryLoading ? 'Generating...' : 'Executive Summary'}</span>
              </button>
              <button className={npStyles.triggerBtn} onClick={() => setNotesOpen(true)}>
                <svg className={npStyles.triggerBtnIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className={styles.btnLabel}>Notes</span>
                {noteCount > 0 && <span className={npStyles.triggerBadge}>{noteCount}</span>}
              </button>
              <span className={styles.notesHintWrap}>
                <button
                  type="button"
                  className={styles.notesHintBtn}
                  aria-label="How to reference a row in notes"
                  aria-describedby="notes-row-reference-tip"
                >
                  ?
                </button>
                <span id="notes-row-reference-tip" role="tooltip" className={styles.notesHintTooltip}>
                  Right click on a row to reference it in a note.
                </span>
              </span>
              <button className={styles.downloadBtn} onClick={handleDownloadPdf}>
                <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                <span className={styles.btnLabel}>Download PDF</span>
              </button>
            </div>
          </div>

        </div>

        {/* ── Filters Panel ── */}
        {filtersOpen && (
          <div className={styles.filtersPanel}>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>Zone</label>
              <select className={styles.filterSelect} value={zoneFilter} onChange={e => setZoneFilter(e.target.value)}>
                <option value="">All Zones</option>
                {zones.map(z => <option key={z.id} value={z.id}>{z.canonicalName}</option>)}
              </select>
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel}>Min. impact</label>
              <div className={styles.thresholdGroup}>
                {thresholds.map(t => (
                  <button
                    key={t.value}
                    className={`${styles.thresholdBtn} ${minDiff === t.value ? styles.thresholdActive : ''}`}
                    onClick={() => setMinDiff(t.value)}
                  >{t.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Columns Panel ── */}
        {columnsOpen && (
          <div className={styles.columnsPanel}>
            {availableCosts.map(col => (
              <label key={col.key} className={styles.columnCheckLabel}>
                <input
                  type="checkbox"
                  checked={visibleCosts.includes(col.key)}
                  onChange={() => toggleCostColumn(col.key)}
                  className={styles.columnCheckbox}
                />
                {col.label}
              </label>
            ))}
          </div>
        )}

        {/* ── Split-view Table ── */}
        {(() => {
          const n = visibleCosts.length;
          const costW = 4;
          const qtyW = 5;
          const totalW = 7;
          const diffTotalW = 6;
          const diffCostW = 4;
          const collapseRailW = 4;
          const costMeta = visibleCosts.map(key => {
            const col = costColumns.find(c => c.key === key);
            return { key, label: col?.label ?? key };
          });

          const yourFixed = qtyW + (n * costW) + totalW;
          const adjusterFixed = adjusterCollapsed ? 0 : qtyW + (n * costW) + totalW;
          const diffFixed = diffCollapsed ? 0 : (n * diffCostW) + diffTotalW;
          const collapsedRails = (adjusterCollapsed ? collapseRailW : 0) + (diffCollapsed ? collapseRailW : 0);
          const remainingForDescriptions = Math.max(10, 100 - yourFixed - adjusterFixed - diffFixed - collapsedRails);
          const yourDescW = adjusterCollapsed ? remainingForDescriptions : remainingForDescriptions / 2;
          const adjusterDescW = adjusterCollapsed ? 0 : remainingForDescriptions / 2;

          const yourCols = 2 + n + 1; /* desc, qty, [costs], total */
          const adjusterCols = adjusterCollapsed ? 1 : (2 + n + 1);
          const diffCols = diffCollapsed ? 1 : (n + 1);

          const estimatedRequiredWidth =
            360 +
            (n * 120) +
            (adjusterCollapsed ? 52 : 300 + (n * 110)) +
            (diffCollapsed ? 52 : 180 + (n * 90));
          const actionGutterReserve = viewportWidth > 0
            ? (viewportWidth <= 1100 ? 120 : viewportWidth <= 1400 ? 104 : 88)
            : 96;
          const estimatedRequiredWidthWithGutter = estimatedRequiredWidth + actionGutterReserve;
          const availableViewportWidth = viewportWidth > 0 ? Math.max(320, viewportWidth - 64) : 1280;
          const atSixtyEightPercentCapacity = estimatedRequiredWidthWithGutter > availableViewportWidth * 0.68;
          const tabletForcedScroll = viewportWidth > 0 && viewportWidth <= 1180 && n >= 2;
          const enableTableScroll = atSixtyEightPercentCapacity || tabletForcedScroll;
          const breathingMultiplier = viewportWidth > 0
            ? (viewportWidth <= 1100 ? 1.22 : viewportWidth <= 1400 ? 1.15 : 1.08)
            : 1.12;
          const tableMinWidthPx = enableTableScroll
            ? Math.max(estimatedRequiredWidthWithGutter, Math.round(availableViewportWidth * breathingMultiplier))
            : undefined;

          return (
            <>
              
              <div
                ref={tableWrapRef}
                className={`${styles.tableWrap} ${enableTableScroll ? styles.tableWrapScrollMode : ''}`}
                onScroll={handleTableWrapScroll}
              >
                <table className={styles.tbl} style={tableMinWidthPx ? { minWidth: `${tableMinWidthPx}px` } : undefined}>
                <colgroup>
                  {/* Your side: desc, qty, [costs], total */}
                  <col style={{ width: `${yourDescW}%` }} />
                  <col style={{ width: `${qtyW}%` }} />
                  {costMeta.map(c => <col key={`yc-${c.key}`} style={{ width: `${costW}%` }} />)}
                  <col style={{ width: `${totalW}%` }} />
                  {/* Adjuster side */}
                  {adjusterCollapsed ? (
                    <col style={{ width: `${collapseRailW}%` }} />
                  ) : (
                    <>
                      <col style={{ width: `${adjusterDescW}%` }} />
                      <col style={{ width: `${qtyW}%` }} />
                      {costMeta.map(c => <col key={`ac-${c.key}`} style={{ width: `${costW}%` }} />)}
                      <col style={{ width: `${totalW}%` }} />
                    </>
                  )}
                  {/* Diff area */}
                  {diffCollapsed ? (
                    <col style={{ width: `${collapseRailW}%` }} />
                  ) : (
                    <>
                      {costMeta.map(c => <col key={`dc-${c.key}`} style={{ width: `${diffCostW}%` }} />)}
                      <col style={{ width: `${diffTotalW}%` }} />
                    </>
                  )}
                </colgroup>
                <thead>
                  <tr>
                    <td colSpan={yourCols} className={styles.centerBorder} style={{ padding: '14px 16px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>Your Estimate</span>
                      {comparison?.yourEstimateFilename && yourEstimateDownloadHref ? (
                        <a className={styles.estimateFileLink} href={yourEstimateDownloadHref} download>
                          {comparison.yourEstimateFilename}
                        </a>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{comparison?.yourEstimateFilename ?? '—'}</span>
                      )}
                    </td>
                    {adjusterCollapsed ? (
                      <td rowSpan={2} className={styles.sideRailHeaderCell}>
                        <button className={styles.sideRailToggleBtn} onClick={toggleAdjusterCollapsed}>
                          <span>A.E.</span>
                          <svg width="12" height="12" viewBox="0 0 14 14"><path d="M5 3.5L8.5 7L5 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      </td>
                    ) : (
                      <td colSpan={adjusterCols} style={{ padding: '14px 16px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-default)' }}>
                        <div className={styles.sideHeaderInner}>
                          <div>
                            <span style={{ fontSize: 15, fontWeight: 600 }}>Adjuster&apos;s Estimate</span>
                            {comparison?.adjusterEstimateFilename && adjusterEstimateDownloadHref ? (
                              <a className={styles.estimateFileLink} href={adjusterEstimateDownloadHref} download>
                                {comparison.adjusterEstimateFilename}
                              </a>
                            ) : (
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{comparison?.adjusterEstimateFilename ?? '—'}</span>
                            )}
                          </div>
                          <button className={styles.sideCollapseToggleBtn} onClick={toggleAdjusterCollapsed} aria-label="Collapse Adjuster side">
                            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3.5L5 7L8.5 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                        </div>
                      </td>
                    )}
                    {diffCollapsed ? (
                      <td rowSpan={2} className={`${styles.sideRailHeaderCell} ${styles.diffRailHeaderCell}`}>
                        <button className={styles.sideRailToggleBtn} onClick={toggleDiffCollapsed}>
                          <span>Diff</span>
                          <svg width="12" height="12" viewBox="0 0 14 14"><path d="M5 3.5L8.5 7L5 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      </td>
                    ) : (
                      <td colSpan={diffCols} className={styles.diffBorder} style={{ padding: '14px 12px', borderBottom: '1px solid var(--border-default)' }}>
                        <div className={styles.sideHeaderInner}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>Diff</span>
                          <button className={styles.sideCollapseToggleBtn} onClick={toggleDiffCollapsed} aria-label="Collapse Diff side">
                            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3.5L5 7L8.5 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  <tr className={styles.colLabels}>
                    {/* Your side labels */}
                    <td className={styles.colLabelTd}>Description</td>
                    <td className={`${styles.colLabelTd} ${styles.colLabelRight}`}>Qty</td>
                    {costMeta.map(c => <td key={`ylh-${c.key}`} className={`${styles.colLabelTd} ${styles.colLabelRight}`}>{c.label}</td>)}
                    <td className={`${styles.colLabelTd} ${styles.colLabelRight} ${styles.centerBorder}`}>Total</td>
                    {!adjusterCollapsed && (
                      <>
                        <td className={styles.colLabelTd}>Description</td>
                        <td className={`${styles.colLabelTd} ${styles.colLabelRight}`}>Qty</td>
                        {costMeta.map(c => <td key={`alh-${c.key}`} className={`${styles.colLabelTd} ${styles.colLabelRight}`}>{c.label}</td>)}
                        <td className={`${styles.colLabelTd} ${styles.colLabelRight}`}>Total</td>
                      </>
                    )}
                    {!diffCollapsed && (
                      <>
                        {costMeta.map((c, i) => <td key={`dlh-${c.key}`} className={`${styles.colLabelTd} ${styles.colLabelRight} ${i === 0 ? styles.diffBorder : ''}`}>{c.label} Δ</td>)}
                        <td className={`${styles.colLabelTd} ${styles.colLabelRight} ${styles.diffTotalHeaderCell} ${n === 0 ? styles.diffBorder : ''}`}>$</td>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className={hasSelection ? styles.hasSelection : undefined}>
                  {(() => { let _rowNum = 0; let _zoneIdx = 0; return zonesWithInserts.map(zone => {
                    const visibleItems = zone.items.filter(r => isRowVisible(r, zone.id));
                    if (visibleItems.length === 0) return null;
                    const isFirstZone = _zoneIdx === 0;
                    _zoneIdx++;
                    return [
                      <tr key={`zh-${zone.id}`} className={`${styles.zoneHeaderRow}${!isFirstZone ? ` ${styles.zoneNewPage}` : ''}${zone.id.startsWith('__newzone__') ? ` ${styles.zoneHeaderDraft}` : ''}`} onClick={() => toggleZone(zone.id)} style={{ cursor: 'pointer' }}>
                        <td colSpan={yourCols} className={styles.centerBorder} style={{ padding: '10px 16px', fontWeight: 600, fontSize: 13, background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border-light)' }} onContextMenu={(e) => openZoneRowMenu(e, zone, 'yours')} onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClickZone(zone, 'yours'); }}>
                          <svg className={`${styles.zoneChevron} ${collapsedZones.has(zone.id) ? styles.zoneChevronCollapsed : ''}`} width="14" height="14" viewBox="0 0 14 14"><path d="M4 5.5L7 8.5L10 5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          {editingZoneId === zone.id && editingZoneSide === 'yours' ? (
                            <input
                              className={styles.zoneNameInput}
                              autoFocus
                              value={editingZoneName}
                              onChange={(e) => setEditingZoneName(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); handleCommitZoneEdit(zone.id, zone.canonicalName); }
                                if (e.key === 'Escape') { e.preventDefault(); handleCancelZoneEdit(); }
                              }}
                              onBlur={() => handleCommitZoneEdit(zone.id, zone.canonicalName)}
                            />
                          ) : (
                            <>
                              {draftZoneNames.get(zone.id) ?? zone.canonicalName}
                              {draftZoneNames.has(zone.id) && <span className={styles.draftIndicator} title="Zone name edited"> ✎</span>}
                              <span className={styles.zoneItemCount}>{visibleItems.length}</span>
                              {zone.confidence !== null && zone.confidence > 0 && (
                                <span className={`${styles.confidenceBadge} ${zone.confidence >= 85 ? styles.confidenceHigh : styles.confidenceMed}`} title={`Zone matching confidence: ${zone.confidence.toFixed(2)}%`}>{zone.confidence.toFixed(2)}%</span>
                              )}
                              {zone.yourName && zone.yourName !== zone.canonicalName && (
                                <span className={styles.zoneAltName}>{zone.yourName}</span>
                              )}
                            </>
                          )}
                        </td>
                        {adjusterCollapsed ? (
                          <td className={styles.sideRailDataCell} style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border-light)' }} />
                        ) : (
                          <td colSpan={adjusterCols} style={{ padding: '10px 16px', fontWeight: 600, fontSize: 13, background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border-light)' }} onContextMenu={(e) => openZoneRowMenu(e, zone, 'adjuster')} onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClickZone(zone, 'adjuster'); }}>
                            {editingZoneId === zone.id && editingZoneSide === 'adjuster' ? (
                              <input
                                className={styles.zoneNameInput}
                                autoFocus
                                value={editingZoneName}
                                onChange={(e) => setEditingZoneName(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); handleCommitZoneEdit(zone.id, zone.canonicalName); }
                                  if (e.key === 'Escape') { e.preventDefault(); handleCancelZoneEdit(); }
                                }}
                                onBlur={() => handleCommitZoneEdit(zone.id, zone.canonicalName)}
                              />
                            ) : (
                              <>
                                {draftAdjusterZoneNames.get(zone.id) ?? zone.adjusterName ?? zone.canonicalName}
                                {draftAdjusterZoneNames.has(zone.id) && <span className={styles.draftIndicator} title="Adjuster zone name edited"> ✎</span>}
                              </>
                            )}
                          </td>
                        )}
                        {diffCollapsed ? (
                          <td className={`${styles.sideRailDataCell} ${styles.diffRailDataCell}`} style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border-light)' }} />
                        ) : (
                          <td colSpan={diffCols} className={styles.diffBorder} style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border-light)' }} />
                        )}
                      </tr>,
                      ...(!collapsedZones.has(zone.id) ? visibleItems.map((row, ri) => {
                        const y = row.your;
                        const a = row.adjuster;
                        const bgMap: Record<string, string> = {
                          match: 'var(--green-50)',
                          match_unverified: 'var(--pill-match-unverified-bg)',
                          modified: 'var(--pill-modified-bg)',
                          missing: 'var(--red-50)',
                          added: 'var(--blue-50)',
                        };
                        const rowKey = `${zone.id}-${ri}`;
                        const isSelected = selectedRow === rowKey;
                        const isEditing = editingRowKey === rowKey && !!row.id;
                        const draft = row.id ? draftEdits.get(row.id) : undefined;
                        const isMoved = !!row.id && draftMoves.has(row.id);
                        const isDrafted = (!!draft && !isEditing) || isMoved;
                        const isDeleted = !!draft?.deleted;
                        const bg = isDeleted
                          ? 'var(--red-50)'
                          : (isEditing || isDrafted)
                          ? 'var(--amber-50)'
                          : (bgMap[row.status] || 'transparent');

                        // Merge editing > draft > original for display
                        const ev = isEditing ? editingValues : draft;
                        const effYDesc = ev ? ev.yDesc : (y?.description ?? '');
                        const effADesc = ev ? ev.aDesc : (a?.description ?? '');
                        const effYQty = ev ? ev.yQty : (y?.qty ?? '');
                        const effAQty = ev ? ev.aQty : (a?.qty ?? '');
                        const parseEditedNum = (raw: string): number | null => {
                          const t = raw.trim();
                          if (!t) return null;
                          const nVal = parseFloat(t);
                          return Number.isFinite(nVal) ? nVal : null;
                        };
                        const effYTotal = ev ? parseEditedNum(ev.yTotal) : (y?.total ?? null);
                        const effATotal = ev ? parseEditedNum(ev.aTotal) : (a?.total ?? null);
                        const effectiveDiff = (effYTotal ?? 0) - (effATotal ?? 0);

                        const getEffCostVal = (side: 'y' | 'a', key: string): number | null => {
                          const k = `${side}${key.charAt(0).toUpperCase() + key.slice(1)}` as keyof EditValues;
                          if (ev) {
                            const parsed = parseEditedNum(ev[k] as string);
                            return parsed;
                          }
                          const li = side === 'y' ? y : a;
                          return li ? (Number(li[key as keyof LineItem]) || 0) : null;
                        };

                        const cellInput = (val: string, evKey: keyof EditValues, isNum?: boolean) => (
                          <input
                            className={styles.editInput}
                            type={isNum ? 'number' : 'text'}
                            value={val}
                            min={isNum ? 0 : undefined}
                            step={isNum ? 'any' : undefined}
                            onKeyDown={isNum ? numericKeyDown : undefined}
                            onChange={(e) => setEditingValues(prev => ({ ...prev, [evKey]: e.target.value }))}
                            onClick={(e) => e.stopPropagation()}
                          />
                        );

                        const handleRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                          if (isEditing) {
                            if (e.key === 'Enter') { e.preventDefault(); handleCommitEdit(row.id!); }
                            if (e.key === 'Escape') { e.preventDefault(); handleCancelEdit(); }
                          }
                        };

                        const rowNum = ++_rowNum;
                        return (
                          <tr
                            key={rowKey}
                            style={{ background: bg }}
                            data-row-key={rowKey}
                            data-status={row.status}
                            className={`${styles.dataRow} ${isSelected || isEditing ? styles.rowSelected : ''} ${isDrafted ? styles.rowDrafted : ''} ${isEditing ? styles.rowEditing : ''} ${rowNoteMenu?.rowKey === rowKey ? styles.rowMenuOpen : ''} ${isDeleted ? styles.rowDeleted : ''} ${flashedRowKey === rowKey ? styles.rowFlash : ''}`}
                            onClick={() => { if (!isEditing) handleRowClick(rowKey); }}
                            onDoubleClick={() => { if (!isEditing && row.id) handleStartEditRow(rowKey, row); }}
                            onKeyDown={handleRowKeyDown}
                            onContextMenu={row.id ? (e) => openRowNoteMenu(e, rowKey, {
                              id: row.id!,
                              descriptionYours: y?.description ?? null,
                              descriptionAdjuster: a?.description ?? null,
                              zoneCanonical: zone.canonicalName,
                            }, row) : undefined}
                          >
                            {/* Your side */}
                            <td className={`${styles.cell} ${isEditing ? styles.cellEditFlex : ''}`}>
                              <span className={styles.rowNum}>
                                {rowNum}
                                {isDrafted && <span className={styles.draftIndicator} title="Pending changes">✎</span>}
                              </span>
                              {isEditing ? cellInput(editingValues.yDesc, 'yDesc') : (effYDesc || '—')}
                            </td>
                            <td className={styles.cellNum}>
                              {isEditing ? cellInput(editingValues.yQty, 'yQty') : effYQty}
                            </td>
                            {costMeta.map(c => {
                              const evKey = `y${c.key.charAt(0).toUpperCase() + c.key.slice(1)}` as keyof EditValues;
                              const val = getEffCostVal('y', c.key);
                              return (
                                <td key={`yr-${c.key}`} className={styles.cellNum}>
                                  {isEditing ? cellInput(editingValues[evKey] as string, evKey, true) : (val === null ? '' : fmt(val))}
                                </td>
                              );
                            })}
                            <td className={`${styles.cellNum} ${styles.cellBold} ${styles.centerBorder}`}>
                              {isEditing
                                ? cellInput(editingValues.yTotal, 'yTotal', true)
                                : (isDrafted ? (effYTotal !== null ? fmt(effYTotal) : '') : (y ? (y.totalDisplay ?? fmt(y.total)) : ''))
                              }
                            </td>
                            {/* Adjuster side */}
                            {adjusterCollapsed ? (
                              <td className={styles.sideRailDataCell} />
                            ) : (
                              <>
                                <td className={`${styles.cell} ${isEditing ? styles.cellEditFlex : ''}`}>
                                  {isEditing ? cellInput(editingValues.aDesc, 'aDesc') : (effADesc || '—')}
                                </td>
                                <td className={styles.cellNum}>
                                  {isEditing ? cellInput(editingValues.aQty, 'aQty') : effAQty}
                                </td>
                                {costMeta.map(c => {
                                  const evKey = `a${c.key.charAt(0).toUpperCase() + c.key.slice(1)}` as keyof EditValues;
                                  const val = getEffCostVal('a', c.key);
                                  return (
                                    <td key={`ar-${c.key}`} className={styles.cellNum}>
                                      {isEditing ? cellInput(editingValues[evKey] as string, evKey, true) : (val === null ? '' : fmt(val))}
                                    </td>
                                  );
                                })}
                                <td className={`${styles.cellNum} ${styles.cellBold}`}>
                                  {isEditing
                                    ? cellInput(editingValues.aTotal, 'aTotal', true)
                                    : (isDrafted ? (effATotal !== null ? fmt(effATotal) : '') : (a ? fmt(a.total) : ''))
                                  }
                                </td>
                              </>
                            )}
                            {/* Diff area */}
                            {diffCollapsed ? (
                              <td className={`${styles.sideRailDataCell} ${styles.diffRailDataCell}`} />
                            ) : (
                              <>
                                {costMeta.map((c, ci) => {
                                  const yVal = getEffCostVal('y', c.key) ?? 0;
                                  const aVal = getEffCostVal('a', c.key) ?? 0;
                                  const d = aVal - yVal;
                                  return (
                                    <td key={`dr-${c.key}`} className={`${styles.cellNum} ${ci === 0 ? styles.diffBorder : ''} ${d > 0 ? styles.diffNeg : d < 0 ? styles.diffPos : ''}`}>
                                      {d !== 0 ? (d > 0 ? '+' : '') + fmt(d) : '—'}
                                    </td>
                                  );
                                })}
                                <td className={`${styles.cellNum} ${styles.cellBold} ${styles.diffTotalValueCell} ${n === 0 ? styles.diffBorder : ''} ${effectiveDiff > 0 ? styles.diffPos : effectiveDiff < 0 ? styles.diffNeg : ''}`}>
                                  {effectiveDiff !== 0 ? `${effectiveDiff > 0 ? '-' : '+'}${fmt(Math.abs(effectiveDiff))}` : '—'}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      }) : [])
                    ];
                  }); })()}
                </tbody>
              </table>
            </div>
            </>
          );
        })()}

        <div className={styles.printReport}>
          {printZones.map(({ zone, items }, zoneIndex) => (
            <section
              key={`print-zone-${zone.id}`}
              className={`${styles.printZoneSection} ${zoneIndex > 0 ? styles.printZoneBreak : ''}`}
            >
              <div className={styles.printZoneTitleRow}>
                <div className={styles.printZoneTitleLeft}>
                  {zone.canonicalName}
                  <span className={styles.printZoneCount}>{items.length} items</span>
                  {zone.confidence !== null && zone.confidence > 0 ? (
                    <span className={styles.printZoneConfidence}>{zone.confidence}%</span>
                  ) : null}
                </div>
                <div className={styles.printZoneTitleRight}>{zone.adjusterName ?? zone.canonicalName}</div>
              </div>

              <table className={`${styles.printZoneTable} ${visibleCosts.length > 2 ? styles.printZoneDense : ''}`}>
                <thead>
                  <tr>
                    <th colSpan={3 + visibleCosts.length} className={styles.printHeadGroup}>
                      Your Estimate <span className={styles.printHeadFile}>{comparison?.yourEstimateFilename ?? '—'}</span>
                    </th>
                    <th colSpan={3 + visibleCosts.length} className={styles.printHeadGroup}>
                      Adjuster&apos;s Estimate <span className={styles.printHeadFile}>{comparison?.adjusterEstimateFilename ?? '—'}</span>
                    </th>
                    <th className={styles.printHeadGroup}>Diff</th>
                  </tr>
                  <tr>
                    <th className={styles.printCol}>Description</th>
                    <th className={styles.printColRight}>Qty</th>
                    {visibleCosts.map(key => {
                      const col = costColumns.find(c => c.key === key);
                      return <th key={`yh-${key}`} className={styles.printColRight}>{col?.label ?? key}</th>;
                    })}
                    <th className={styles.printColRight}>Total</th>
                    <th className={styles.printCol}>Description</th>
                    <th className={styles.printColRight}>Qty</th>
                    {visibleCosts.map(key => {
                      const col = costColumns.find(c => c.key === key);
                      return <th key={`ah-${key}`} className={styles.printColRight}>{col?.label ?? key}</th>;
                    })}
                    <th className={styles.printColRight}>Total</th>
                    <th className={styles.printColRight}>$</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row, rowIndex) => {
                    const y = row.your;
                    const a = row.adjuster;
                    const diff = (y?.total ?? 0) - (a?.total ?? 0);
                    const statusClassMap: Record<Row['status'], string> = {
                      match: styles.printStatusMatch,
                      match_unverified: styles.printStatusMatchUnverified,
                      modified: styles.printStatusModified,
                      missing: styles.printStatusMissing,
                      added: styles.printStatusAdded,
                    };
                    return (
                      <tr key={`print-row-${zone.id}-${rowIndex}`} className={`${styles.printDataRow} ${statusClassMap[row.status]}`}>
                        <td className={styles.printCell}>{y?.description ?? '—'}</td>
                        <td className={styles.printCellNum}>{y?.qty ?? ''}</td>
                        {visibleCosts.map(key => {
                          const val = y ? (y[key as keyof LineItem] as number) : null;
                          return <td key={`yc-${key}`} className={styles.printCellNum}>{val != null && val !== 0 ? fmt(val) : ''}</td>;
                        })}
                        <td className={`${styles.printCellNum} ${styles.printCellBold}`}>{y ? (y.totalDisplay ?? fmt(y.total)) : ''}</td>
                        <td className={styles.printCell}>{a?.description ?? '—'}</td>
                        <td className={styles.printCellNum}>{a?.qty ?? ''}</td>
                        {visibleCosts.map(key => {
                          const val = a ? (a[key as keyof LineItem] as number) : null;
                          return <td key={`ac-${key}`} className={styles.printCellNum}>{val != null && val !== 0 ? fmt(val) : ''}</td>;
                        })}
                        <td className={`${styles.printCellNum} ${styles.printCellBold}`}>{a ? (a.totalDisplay ?? fmt(a.total)) : ''}</td>
                        <td className={`${styles.printCellNum} ${styles.printCellBold} ${diff > 0 ? styles.diffPos : diff < 0 ? styles.diffNeg : ''}`}>
                          {diff !== 0 ? `${diff > 0 ? '-' : '+'}${fmt(Math.abs(diff))}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </div>

        {/* ── Print-only: Comparison Notes ── */}
        {printNotes.length > 0 && (
          <div className={styles.printNotes}>
            <div className={styles.printNotesHeader}>
              <h2 className={styles.printNotesTitle}>Comparison Notes</h2>
              <span className={styles.printNotesCount}>{printNotes.length} note{printNotes.length !== 1 ? 's' : ''}</span>
            </div>
            {printNotes.map((note) => (
              <div key={note.id} className={styles.printNoteCard}>
                <div className={styles.printNoteCardMeta}>
                  {note.lineItem ? (
                    <div className={styles.printNoteContext}>
                      {note.lineItem.zoneCanonical && (
                        <span className={styles.printNoteZone}>{note.lineItem.zoneCanonical}{' — '}</span>
                      )}
                      {note.lineItem.sortOrder != null && (
                        <span className={styles.printNoteNum}>#{note.lineItem.sortOrder}</span>
                      )}
                      <span className={styles.printNoteLineItemDesc}>
                        {note.lineItem.descriptionYours ?? note.lineItem.descriptionAdjuster ?? 'Line item'}
                      </span>
                    </div>
                  ) : (
                    <span className={styles.printNoteGeneralBadge}>General</span>
                  )}
                  <span className={styles.printNoteDate}>
                    {new Date(note.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric', month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className={styles.printNoteContent}>{note.content}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Mobile Summary Dashboard (shown < 768px) ── */}
        <div className={styles.mDash}>
          <div className={styles.mDashTotals}>
            <div className={styles.mDashCol}>
              <p className={styles.mDashLabel}>Your estimate</p>
              <p className={styles.mDashValue}>${fmt(stats.yourTotal)}</p>
              <p className={styles.mDashSub}>{stats.total - stats.counts.added} items</p>
            </div>
            <div className={styles.mDashCol}>
              <p className={styles.mDashLabel}>Adjuster&apos;s</p>
              <p className={styles.mDashValue}>${fmt(stats.adjTotal)}</p>
              <p className={styles.mDashSub}>{stats.total - stats.counts.missing} items</p>
            </div>
            <div className={styles.mDashCol}>
              <p className={styles.mDashLabel}>Gap</p>
              <p className={`${styles.mDashValue} ${stats.gap === 0 ? '' : isYourEstimateLower ? styles.mDashSuccess : styles.mDashDanger}`}>
                {totalGapPrefix}${fmt(gapAbsolute)}
              </p>
              <p className={styles.mDashSub}>{gapDirectionText}</p>
            </div>
          </div>

          <div className={styles.mDashStatus}>
            <p className={styles.mDashStatusTitle}>Breakdown</p>
            <div className={styles.mDashStatusGrid}>
              <div className={styles.mDashStat}><span className={`${styles.mDashDot} ${styles.dotMatch}`} /><span className={styles.mDashStatCount}>{stats.counts.match}</span><span className={styles.mDashStatLabel}>&nbsp;{statusLabel.match.toLowerCase()}</span></div>
              <div className={styles.mDashStat}><span className={`${styles.mDashDot} ${styles.dotMatchUnverified}`} /><span className={styles.mDashStatCount}>{stats.counts.match_unverified}</span><span className={styles.mDashStatLabel}>&nbsp;{statusLabel.match_unverified.toLowerCase()}</span></div>
              <div className={styles.mDashStat}><span className={`${styles.mDashDot} ${styles.dotModified}`} /><span className={styles.mDashStatCount}>{stats.counts.modified}</span><span className={styles.mDashStatLabel}>&nbsp;{statusLabel.modified.toLowerCase()}</span></div>
              <div className={styles.mDashStat}><span className={`${styles.mDashDot} ${styles.dotMissing}`} /><span className={styles.mDashStatCount}>{stats.counts.missing}</span><span className={styles.mDashStatLabel}>&nbsp;{statusLabel.missing.toLowerCase()}</span></div>
              <div className={styles.mDashStat}><span className={`${styles.mDashDot} ${styles.dotAdded}`} /><span className={styles.mDashStatCount}>{stats.counts.added}</span><span className={styles.mDashStatLabel}>&nbsp;{statusLabel.added.toLowerCase()}</span></div>
            </div>
          </div>

          <div className={styles.mDashZones}>
            <p className={styles.mDashZonesTitle}>Gap by zone</p>
            {zoneGaps.map(z => (
              <div key={z.name} className={styles.mZoneRow}>
                <div className={styles.mZoneName}>{z.name}</div>
                <div className={styles.mZoneTrack}>
                  <div
                    className={`${styles.mZoneFill} ${z.gap > 0 ? styles.zoneFillDanger : styles.zoneFillSuccess}`}
                    style={{ width: `${(Math.abs(z.gap) / maxGap) * 100}%` }}
                  />
                </div>
                <div className={`${styles.mZoneAmount} ${z.gap > 0 ? styles.dashDanger : styles.dashSuccess}`}>
                  {z.gap > 0 ? '-' : z.gap < 0 ? '+' : ''}{fmt(Math.abs(z.gap))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Mobile Filter Pills (shown < 768px) ── */}
        <div className={styles.mToolbar}>
          {(['match', 'match_unverified', 'modified', 'missing', 'added'] as StatusFilter[]).map(f => (
            <button
              key={f}
              className={`${styles.mPill} ${styles[`mPill_${f}`]} ${activeFilters.has(f) ? styles.mPillActive : ''}`}
              onClick={() => toggleFilter(f)}
            >
              <span className={styles.mPillDot} />
              {statusLabel[f]}
              <span className={styles.mPillCount}>{stats.counts[f]}</span>
            </button>
          ))}
        </div>

        {/* ── Mobile Card List (shown < 768px) ── */}
        <div className={styles.cardList}>
          {zonesWithInserts.flatMap(zone =>
            zone.items.filter(r => isRowVisible(r, zone.id)).map((row, ri) => {
              const y = row.your;
              const a = row.adjuster;
              const diff = (y?.total ?? 0) - (a?.total ?? 0);
              const cardKey = `card-${zone.id}-${ri}`;

              if (row.status === 'match') {
                return (
                  <div key={cardKey} className={styles.card}>
                    <div className={styles.cardIcon}>
                      <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#639922" /><path d="M7 11 L10 14 L15.5 7.5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </div>
                    {y && (
                      <div className={`${styles.cardSection} ${styles.cardSectionBordered}`}>
                        <p className={styles.cardLabel}>Your estimate</p>
                        <p className={styles.cardDesc}>{y.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{y.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(y.total)}</span></div>
                      </div>
                    )}
                    {a && (
                      <div className={`${styles.cardSection} ${styles.cardSectionBordered}`}>
                        <p className={styles.cardLabel}>Adjuster&apos;s estimate</p>
                        <p className={styles.cardDesc}>{a.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{a.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(a.total)}</span></div>
                      </div>
                    )}
                    <div className={styles.cardMatch}>
                      <div className={styles.cardMatchRow}><span className={styles.cardRowLabel}>Difference</span><span className={styles.cardRowValueSuccess}>${fmt(Math.abs(diff))}</span></div>
                    </div>
                    {row.id && (
                      <button className={npStyles.cardNoteBtn} onClick={() => openNoteForLineItem({ id: row.id!, descriptionYours: y?.description ?? null, descriptionAdjuster: a?.description ?? null, zoneCanonical: zone.canonicalName })}>
                        <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H5L2 14V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {(notesByLineItem.get(row.id) ?? 0) > 0 ? <><span className={npStyles.cardNoteBtnBadge}>{notesByLineItem.get(row.id)}</span> Notes</> : 'Add note'}
                      </button>
                    )}
                  </div>
                );
              }

              if (row.status === 'match_unverified') {
                return (
                  <div key={cardKey} className={styles.card}>
                    <div className={styles.cardIcon}>
                      <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#7B8FA3" /><circle cx="11" cy="7" r="1.25" fill="white" /><path d="M11 10 L11 16" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
                    </div>
                    {y && (
                      <div className={`${styles.cardSection} ${styles.cardSectionBordered}`}>
                        <p className={styles.cardLabel}>Your estimate</p>
                        <p className={styles.cardDesc}>{y.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{y.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(y.total)}</span></div>
                      </div>
                    )}
                    <div className={styles.cardBanner} style={{ background: 'var(--pill-match-unverified-bg)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--pill-match-unverified-text, #475569)', fontWeight: 600, fontSize: 13 }}>
                        <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#7B8FA3" strokeWidth="1.5" /><circle cx="8" cy="5.5" r="0.75" fill="#7B8FA3" /><path d="M8 7.5 L8 11.5" stroke="#7B8FA3" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        Matched — adjuster price unreadable
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Item exists in adjuster&apos;s estimate but the total could not be extracted from the PDF</p>
                    </div>
                    {row.id && (
                      <button className={npStyles.cardNoteBtn} onClick={() => openNoteForLineItem({ id: row.id!, descriptionYours: y?.description ?? null, descriptionAdjuster: a?.description ?? null, zoneCanonical: zone.canonicalName })}>
                        <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H5L2 14V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {(notesByLineItem.get(row.id) ?? 0) > 0 ? <><span className={npStyles.cardNoteBtnBadge}>{notesByLineItem.get(row.id)}</span> Notes</> : 'Add note'}
                      </button>
                    )}
                  </div>
                );
              }

              if (row.status === 'modified') {
                const isExpanded = expandedCards.has(cardKey);
                const replaceDiff = (y?.replace ?? 0) - (a?.replace ?? 0);
                return (
                  <div key={cardKey} className={styles.card}>
                    <div className={styles.cardIcon}>
                      <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#E24B4A" /><path d="M11 6 L11 12" stroke="white" strokeWidth="2" strokeLinecap="round" /><circle cx="11" cy="15.5" r="1.25" fill="white" /></svg>
                    </div>
                    {y && (
                      <div className={`${styles.cardSection} ${styles.cardSectionBordered}`}>
                        <p className={styles.cardLabel}>Your estimate</p>
                        <p className={styles.cardDesc}>{y.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{y.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(y.total)}</span></div>
                      </div>
                    )}
                    {a && (
                      <div className={`${styles.cardSection} ${styles.cardSectionBordered}`}>
                        <p className={styles.cardLabel}>Adjuster&apos;s estimate</p>
                        <p className={styles.cardDesc}>{a.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{a.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(a.total)}</span></div>
                      </div>
                    )}
                    <div className={styles.cardDiff} onClick={() => toggleCardDetail(cardKey)}>
                      <div className={styles.cardDiffContent}>
                        <p className={styles.cardDiffTitle}>Difference</p>
                        <div className={styles.cardDiffRows}>
                          {y && a && (
                            <>
                              <div className={styles.cardRowSm}><span className={styles.cardRowLabel}>Quantity</span><span className={diff > 0 ? styles.cardRowValueDanger : styles.cardRowValueSuccess}>{y.qty} vs {a.qty}</span></div>
                              <div className={styles.cardRowSm}><span className={styles.cardRowLabel}>Total</span><span className={diff > 0 ? styles.cardRowValueDanger : styles.cardRowValueSuccess}>{diff > 0 ? '-' : '+'}${fmt(Math.abs(diff))}</span></div>
                            </>
                          )}
                        </div>
                      </div>
                      <svg className={`${styles.cardChevron} ${isExpanded ? styles.cardChevronOpen : ''}`} width="16" height="16" viewBox="0 0 16 16">
                        <path d="M4 6 L8 10 L12 6" fill="none" stroke="#B4B2A9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {isExpanded && y && a && (
                      <div className={styles.cardDetail}>
                        <div className={styles.cardDetailInner}>
                          <p className={styles.cardDetailLabel}>Cost breakdown</p>
                          <div className={styles.breakdownGrid}>
                            <span></span><span className={styles.breakdownHeader}>Yours</span><span className={styles.breakdownHeader}>Theirs</span><span className={styles.breakdownHeader}>Diff</span>
                            <span className={styles.breakdownLabel}>Replace</span>
                            <span className={styles.breakdownValue}>${fmt(y.replace)}</span>
                            <span className={styles.breakdownValue}>${fmt(a.replace)}</span>
                            <span className={replaceDiff === 0 ? styles.breakdownNeutral : replaceDiff > 0 ? styles.breakdownDanger : styles.breakdownSuccess}>
                              {replaceDiff === 0 ? '—' : `${replaceDiff > 0 ? '-' : '+'}$${fmt(Math.abs(replaceDiff))}`}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    {row.id && (
                      <button className={npStyles.cardNoteBtn} onClick={() => openNoteForLineItem({ id: row.id!, descriptionYours: y?.description ?? null, descriptionAdjuster: a?.description ?? null, zoneCanonical: zone.canonicalName })}>
                        <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H5L2 14V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {(notesByLineItem.get(row.id) ?? 0) > 0 ? <><span className={npStyles.cardNoteBtnBadge}>{notesByLineItem.get(row.id)}</span> Notes</> : 'Add note'}
                      </button>
                    )}
                  </div>
                );
              }

              if (row.status === 'missing') {
                return (
                  <div key={cardKey} className={`${styles.card} ${styles.cardDanger}`}>
                    <div className={styles.cardIcon}>
                      <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#E24B4A" /><path d="M11 6 L11 12" stroke="white" strokeWidth="2" strokeLinecap="round" /><circle cx="11" cy="15.5" r="1.25" fill="white" /></svg>
                    </div>
                    {y && (
                      <div className={styles.cardSection}>
                        <p className={styles.cardLabel}>Your estimate</p>
                        <p className={styles.cardDesc}>{y.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{y.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${y.totalDisplay ?? fmt(y.total)}</span></div>
                      </div>
                    )}
                    <div className={`${styles.cardBanner} ${styles.cardBannerDanger}`}>
                      <div className={styles.cardBannerTitleDanger}>
                        <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#A32D2D" strokeWidth="1.5" /><path d="M5 8 L11 8" stroke="#A32D2D" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        Not in adjuster&apos;s estimate
                      </div>
                      <p className={styles.cardBannerSubDanger}>${y ? (y.totalDisplay ?? fmt(y.total)) : '0.00'} not covered</p>
                    </div>
                    {row.id && (
                      <button className={npStyles.cardNoteBtn} onClick={() => openNoteForLineItem({ id: row.id!, descriptionYours: y?.description ?? null, descriptionAdjuster: null, zoneCanonical: zone.canonicalName })}>
                        <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H5L2 14V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {(notesByLineItem.get(row.id) ?? 0) > 0 ? <><span className={npStyles.cardNoteBtnBadge}>{notesByLineItem.get(row.id)}</span> Notes</> : 'Add note'}
                      </button>
                    )}
                  </div>
                );
              }

              if (row.status === 'added') {
                return (
                  <div key={cardKey} className={`${styles.card} ${styles.cardInfo}`}>
                    <div className={styles.cardIcon}>
                      <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="#378ADD" /><circle cx="11" cy="7" r="1.25" fill="white" /><path d="M11 10 L11 16" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
                    </div>
                    <div className={`${styles.cardBanner} ${styles.cardBannerInfo}`}>
                      <div className={styles.cardBannerTitleInfo}>
                        <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#185FA5" strokeWidth="1.5" /><circle cx="8" cy="5.5" r="0.75" fill="#185FA5" /><path d="M8 7.5 L8 11.5" stroke="#185FA5" strokeWidth="1.5" strokeLinecap="round" /></svg>
                        Added by adjuster
                      </div>
                      <p className={styles.cardBannerSubInfo}>Review — this item was not in your estimate</p>
                    </div>
                    {a && (
                      <div className={styles.cardSection}>
                        <p className={styles.cardLabel}>Adjuster&apos;s estimate</p>
                        <p className={styles.cardDesc}>{a.description}</p>
                        <span className={styles.zoneBadge}>{zone.canonicalName}</span>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Quantity</span><span className={styles.cardRowValue}>{a.qty}</span></div>
                        <div className={styles.cardRow}><span className={styles.cardRowLabel}>Total</span><span className={styles.cardRowValue}>${fmt(a.total)}</span></div>
                      </div>
                    )}
                    {row.id && (
                      <button className={npStyles.cardNoteBtn} onClick={() => openNoteForLineItem({ id: row.id!, descriptionYours: null, descriptionAdjuster: a?.description ?? null, zoneCanonical: zone.canonicalName })}>
                        <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 10a1.5 1.5 0 0 1-1.5 1.5H5L2 14V3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {(notesByLineItem.get(row.id) ?? 0) > 0 ? <><span className={npStyles.cardNoteBtnBadge}>{notesByLineItem.get(row.id)}</span> Notes</> : 'Add note'}
                      </button>
                    )}
                  </div>
                );
              }

              return null;
            })
          )}

          <button className={npStyles.cardNoteBtn} style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={() => setNotesOpen(true)}>
            <svg className={npStyles.cardNoteBtnIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Notes {noteCount > 0 && <span className={npStyles.cardNoteBtnBadge}>{noteCount}</span>}
          </button>
          <button className={styles.mDownloadBtn} onClick={handleDownloadPdf}>
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Download PDF
          </button>
          <button className={styles.mEditEntriesBtn} onClick={() => setLlmEditOpen(true)}>
            <svg viewBox="0 0 24 24"><path d="M20 6h-4v14h4v-4h-4v-6h4zm-6 0h-4v6h4v-6zm-8 8h4v-6h-4v6zm-8 0h4v-4h-4v4zm-2-2v6h4v-6h-4z" /></svg>
            LLM Edit
          </button>
          <button className={styles.mSummaryBtn} onClick={() => void handleSummaryConfirmOpen(false)} disabled={summaryLoading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
            {summaryLoading ? 'Generating...' : 'Executive Summary'}
          </button>
        </div>

        <p className={styles.aiDisclaimer}>Results are generated by AI and may not be perfectly accurate. Please review all line items carefully before making decisions.</p>

        <div className={styles.backRow}>
          <Link
            className={styles.backLink}
            href="/app/comparisons"
            onClick={(e) => {
              if (draftEdits.size > 0) {
                e.preventDefault();
                navigateGuarded(() => router.push('/app/comparisons'));
              }
            }}
          >&larr; All Comparisons</Link>
        </div>
      </div>

      {llmEditOpen && (
        <div
          className={styles.llmEditShell}
          role="dialog"
          aria-modal="true"
          aria-labelledby="llm-edit-title"
          onClick={() => { if (!llmEditLoading) { setLlmEditOpen(false); setLlmEditSuccess(null); } }}
        >
          <div className={styles.llmEditPanel} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={styles.llmEditCloseBtn}
              aria-label="Close LLM Edit"
              onClick={() => { setLlmEditOpen(false); setLlmEditSuccess(null); }}
            >
              ×
            </button>

            {llmEditSuccess ? (
              <>
                <h2 id="llm-edit-title" className={styles.llmEditTitle}>Changes Applied</h2>
                <p className={styles.llmEditSuccessMsg}>{llmEditSuccess}</p>
                <div className={styles.llmEditSuccessActions}>
                  <button
                    type="button"
                    className={styles.llmEditSubmitBtn}
                    onClick={() => { setLlmEditSuccess(null); }}
                  >
                    Make Another Edit
                  </button>
                  <button
                    type="button"
                    className={styles.llmEditSecondaryBtn}
                    onClick={() => { setLlmEditOpen(false); setLlmEditSuccess(null); }}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="llm-edit-title" className={styles.llmEditTitle}>LLM Edit</h2>

                <p className={styles.llmEditInstructions}>
                  LLMs accurately process the changes you need from direct human language. Simply type in
                  human terms, with as much detail as you think is necessary for the changes you want made,
                  then hit Enter and the LLM will make and highlight the changes. This feature is typically
                  used for bulk changes, but can be used for fine-tuning as well.
                </p>

                <div className={styles.llmEditExamples}>
                  <p><strong>Ex 1:</strong> Create a new zone called &quot;Unmatched.&quot; Move all line items that have missing entries on either my estimate, or the adjuster&apos;s, to this new zone.</p>
                  <p><strong>Ex 2:</strong> On line item 32, remove the entry on MY estimate only. Keep the adjuster&apos;s.</p>
                </div>

                <textarea
                  className={styles.llmEditTextarea}
                  placeholder="Describe the edits you want the LLM to make..."
                  value={llmEditPrompt}
                  onChange={(e) => setLlmEditPrompt(e.target.value)}
                  disabled={llmEditLoading}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      handleLlmEditSubmit();
                    }
                  }}
                />

                {llmEditError && (
                  <p className={styles.llmEditErrorMsg}>{llmEditError}</p>
                )}

                <button
                  type="button"
                  className={styles.llmEditSubmitBtn}
                  onClick={handleLlmEditSubmit}
                  disabled={llmEditLoading || !llmEditPrompt.trim()}
                >
                  {llmEditLoading ? 'Applying edits...' : 'Apply Edits'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {summaryConfirmOpen && (
        <div className={styles.summaryConfirmOverlay} onClick={() => setSummaryConfirmOpen(false)}>
          <div className={styles.summaryConfirmDialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="summary-confirm-title">
            <h3 id="summary-confirm-title" className={styles.summaryConfirmTitle}>
              {summaryConfirmIsRegen ? 'Regenerate Executive Summary?' : 'Generate Executive Summary'}
            </h3>
            <p className={styles.summaryConfirmDesc}>
              {summaryConfirmIsRegen
                ? <>A new report will be generated using your comparison data{summaryInstructions.trim() ? ' and the additional context you provided' : ''}. <strong>This will count as an additional executive summary credit.</strong></>
                : 'An AI-powered analysis of your comparison — covering financial gaps, key discrepancies, zone-by-zone breakdowns, and prioritized next steps. The report can be printed or exported.'}
            </p>
            {summaryUsageLoading ? (
              <div className={styles.summaryConfirmUsageRow}>
                <span className={styles.summaryConfirmUsageLabel}>Checking usage…</span>
              </div>
            ) : summaryUsage ? (
              <div className={styles.summaryConfirmUsageRow}>
                <div className={styles.summaryConfirmUsageBar}>
                  <div
                    className={styles.summaryConfirmUsageFill}
                    style={{ width: `${Math.min(100, summaryUsage.limit > 0 ? (summaryUsage.used / summaryUsage.limit) * 100 : 0)}%` }}
                  />
                </div>
                <span className={styles.summaryConfirmUsageLabel}>
                  {summaryUsage.used} of {summaryUsage.limit} executive {summaryUsage.limit === 1 ? 'summary' : 'summaries'} used this billing period
                </span>
              </div>
            ) : null}
            <div className={styles.summaryConfirmActions}>
              <button type="button" className={styles.summaryConfirmCancelBtn} onClick={() => setSummaryConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.summaryConfirmGenerateBtn}
                onClick={handleSummaryConfirm}
                disabled={!!(summaryUsage && summaryUsage.used >= summaryUsage.limit && summaryUsage.limit > 0)}
              >
                {summaryConfirmIsRegen ? 'Regenerate Report' : 'Generate Report'}
              </button>
            </div>
          </div>
        </div>
      )}

      {summaryOpen && (
        <div
          className={styles.summaryShell}
          role="dialog"
          aria-modal="true"
          aria-labelledby="summary-title"
          onClick={() => setSummaryOpen(false)}
        >
          <div className={styles.summaryPanel} onClick={(e) => e.stopPropagation()}>
            <div className={styles.summaryToolbar}>
              <h2 id="summary-title" className={styles.summaryToolbarTitle}>Executive Summary</h2>
              <div className={styles.summaryToolbarActions}>
                {summaryMarkdown && !summaryLoading && (
                  <>
                    <button type="button" className={styles.summaryActionBtn} onClick={handlePrintSummary}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
                      Print
                    </button>
                  </>
                )}
                <button type="button" className={styles.summaryCloseBtn} aria-label="Close" onClick={() => setSummaryOpen(false)}>
                  &times;
                </button>
              </div>
            </div>
            <div className={styles.summaryBody}>
              {summaryLoading && (
                <div className={styles.summaryLoading}>
                  <div className={styles.summarySpinner} />
                  <p>Generating executive summary&hellip;</p>
                  <p className={styles.summaryLoadingSub}>This may take 15&ndash;30 seconds depending on the size of your comparison.</p>
                </div>
              )}
              {summaryError && (
                <div className={styles.summaryErrorBanner}>
                  <p><strong>Error:</strong> {summaryError}</p>
                  <button type="button" className={styles.summaryRetryBtn} onClick={handleGenerateSummary}>Try Again</button>
                </div>
              )}
              {summaryMarkdown && !summaryLoading && (
                <>
                  <div
                    className={styles.summaryContent}
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(summaryMarkdown) }}
                  />
                  <div className={styles.summaryRegenSection}>
                    <p className={styles.summaryRegenLabel}>Regenerate with additional context</p>
                    <p className={styles.summaryRegenNote}>Each regeneration uses one executive summary credit from your monthly allowance.</p>
                    <textarea
                      className={styles.summaryRegenTextarea}
                      placeholder="Add focus areas, dispute strategy, or any specific context you want included in the report…"
                      value={summaryInstructions}
                      onChange={(e) => setSummaryInstructions(e.target.value)}
                      rows={3}
                    />
                    <button
                      type="button"
                      className={styles.summaryRegenBtn}
                      onClick={() => void handleSummaryConfirmOpen(true)}
                      disabled={summaryLoading}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                      Regenerate Report
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {rowNoteMenu && (
        <div
          ref={rowNoteMenuRef}
          className={styles.rowNoteMenu}
          style={{ left: `${rowNoteMenu.x}px`, top: `${rowNoteMenu.y}px` }}
        >
          {/* Line item only: Edit row */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id && !draftEdits.get(rowNoteMenu.row.id)?.deleted && (
            <button className={styles.rowNoteMenuItem} onClick={() => handleStartEditRow(rowNoteMenu.rowKey, rowNoteMenu.row)}>
              Edit row
            </button>
          )}
          {/* Zone row: add to zone (real and virtual zones) */}
          {rowNoteMenu.isZoneRow && rowNoteMenu.zoneId && (
            <button className={styles.rowNoteMenuItem} onClick={handleAddLineItemAbove}>Add line item to zone</button>
          )}
          {/* Blank item inside virtual zone: add more items */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id?.startsWith('__new__') && rowNoteMenu.rowKey.includes('__newzone__') && (
            <button className={styles.rowNoteMenuItem} onClick={handleAddLineItemAbove}>Add line item to zone</button>
          )}
          {/* Line item row: add above */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id && !rowNoteMenu.row.id.startsWith('__new__') && (
            <button className={styles.rowNoteMenuItem} onClick={handleAddLineItemAbove}>Add line item above</button>
          )}
          {/* Both: Add zone above */}
          {rowNoteMenu.row.id && !rowNoteMenu.row.id.startsWith('__new__') && (
            <button className={styles.rowNoteMenuItem} onClick={handleAddZoneAbove}>Add zone above</button>
          )}
          {/* Line item only: Make a note */}
          {!rowNoteMenu.isZoneRow && (
            <button className={styles.rowNoteMenuItem} onClick={handleMakeRowNote}>Make a note</button>
          )}
          {/* Line item only: Move to zone */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id && !rowNoteMenu.row.id.startsWith('__new__') && !draftEdits.get(rowNoteMenu.row.id)?.deleted && (() => {
            const currentZoneId = zonesWithInserts.find(z => z.items.some(r => r.id === rowNoteMenu.row.id))?.id;
            const availableZones = zonesWithInserts.filter(z => z.id !== currentZoneId);
            if (availableZones.length === 0) return null;
            return (
              <div
                className={styles.rowNoteMenuItemWithSub}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const spaceRight = window.innerWidth - rect.right;
                  const side = spaceRight >= 200 ? 'right' : 'left';
                  setMoveToZoneSubmenu({ side });
                }}
                onMouseLeave={() => setMoveToZoneSubmenu(null)}
              >
                <span className={styles.rowNoteMenuItem}>Move to <span className={styles.subMenuChevron}>{'\u203a'}</span></span>
                {moveToZoneSubmenu && (
                  <div className={`${styles.moveToSubmenu} ${moveToZoneSubmenu.side === 'left' ? styles.moveToSubmenuLeft : ''}`}>
                    {availableZones.map(z => (
                      <button
                        key={z.id}
                        className={styles.rowNoteMenuItem}
                        onMouseDown={(e) => { e.preventDefault(); handleMoveToZone(z.id); }}
                      >
                        {z.yourName ?? z.canonicalName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          {/* Line item only: Delete row */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id && !rowNoteMenu.row.id.startsWith('__new__') && !draftEdits.get(rowNoteMenu.row.id)?.deleted && (
            <button className={`${styles.rowNoteMenuItem} ${styles.rowNoteMenuItemDanger}`} onClick={handleDeleteRow}>Delete row</button>
          )}
          {/* Zone row only: Edit zone name */}
          {rowNoteMenu.isZoneRow && (
            <button className={styles.rowNoteMenuItem} onClick={handleStartEditZone}>Edit zone name</button>
          )}
          {/* Zone row only: Delete zone */}
          {rowNoteMenu.isZoneRow && (
            <button className={`${styles.rowNoteMenuItem} ${styles.rowNoteMenuItemDanger}`} onClick={handleDeleteZoneClick}>Delete zone</button>
          )}
          {/* Line item only: Discard/Restore draft */}
          {!rowNoteMenu.isZoneRow && rowNoteMenu.row.id && draftEdits.has(rowNoteMenu.row.id) && (
            <button className={`${styles.rowNoteMenuItem} ${styles.rowNoteMenuItemDanger}`} onClick={handleDiscardRowEdit}>
              {draftEdits.get(rowNoteMenu.row.id)?.deleted ? 'Restore row' : 'Discard changes'}
            </button>
          )}
        </div>
      )}

      {tableScrollOverlay.visible && (
        <div
          className={styles.tableScrollOverlayShell}
          style={{ left: `${tableScrollOverlay.left}px`, width: `${tableScrollOverlay.width}px` }}
        >
          <div
            ref={tableScrollOverlayRef}
            className={styles.tableScrollOverlayTrack}
            onScroll={handleOverlayScroll}
          >
            <div style={{ width: `${tableScrollOverlay.contentWidth}px`, height: '1px' }} />
          </div>
        </div>
      )}

      {comparisonId && (
        <NotesPanel
          comparisonId={comparisonId}
          isOpen={notesOpen}
          onClose={() => setNotesOpen(false)}
          targetLineItem={noteTarget}
          onClearTarget={() => setNoteTarget(null)}
          onNotesLoaded={handleNotesLoaded}
          onNotesByLineItem={handleNotesByLineItem}
          onNotesData={handleNotesData}
          onLineItemNoteNavigate={handleLineItemNoteNavigate}
          rowNumberMap={rowNumberMap}
          activeItemIds={activeItemIds}
        />
      )}

      {showSaveConfirm && (
        <div className={styles.unsavedGuardOverlay} onClick={() => setShowSaveConfirm(false)}>
          <div className={styles.unsavedGuardDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.unsavedGuardTitle}>Confirm new version</p>
            <p className={styles.unsavedGuardBody}>
              You&apos;re about to save {draftEdits.size} change{draftEdits.size !== 1 ? 's' : ''} as a new version. Please double-check your edits before proceeding — this cannot be undone automatically.
            </p>
            <div className={styles.unsavedGuardActions}>
              <button
                className={styles.unsavedGuardSaveBtn}
                disabled={savingDraft}
                onClick={async () => {
                  setShowSaveConfirm(false);
                  await executeSaveDraft();
                }}
              >
                {savingDraft ? 'Saving...' : 'Yes, save as new version'}
              </button>
              <button className={styles.unsavedGuardCancelBtn} onClick={() => setShowSaveConfirm(false)}>
                Go back and review
              </button>
            </div>
          </div>
        </div>
      )}

      {saveDraftErrors && (
        <div className={styles.unsavedGuardOverlay} onClick={() => setSaveDraftErrors(null)}>
          <div className={styles.unsavedGuardDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.unsavedGuardTitle}>Cannot Save Version</p>
            <p className={styles.unsavedGuardBody}>Please fix the following issues before saving:</p>
            <ul className={styles.saveDraftErrorList}>
              {saveDraftErrors.map((err, i) => <li key={i}>{err}</li>)}
            </ul>
            <div className={styles.unsavedGuardActions}>
              <button className={styles.unsavedGuardCancelBtn} onClick={() => setSaveDraftErrors(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {unsavedGuardOpen && (
        <div className={styles.unsavedGuardOverlay} onClick={() => setUnsavedGuardOpen(false)}>
          <div className={styles.unsavedGuardDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.unsavedGuardTitle}>Unsaved changes</p>
            <p className={styles.unsavedGuardBody}>
              You have {draftEdits.size} row edit{draftEdits.size !== 1 ? 's' : ''} that haven&apos;t been saved as a version yet. What would you like to do?
            </p>
            <div className={styles.unsavedGuardActions}>
              <button
                className={styles.unsavedGuardSaveBtn}
                disabled={savingDraft}
                onClick={async () => {
                  const saved = await handleSaveDraftAsVersion();
                  if (!saved) return;
                  setUnsavedGuardOpen(false);
                  unsavedGuardCallbackRef.current?.();
                  unsavedGuardCallbackRef.current = null;
                }}
              >
                {savingDraft ? 'Saving...' : 'Save as new version'}
              </button>
              <button
                className={styles.unsavedGuardDiscardBtn}
                onClick={() => {
                  const empty = new Map<string, EditValues>();
                  draftEditsRef.current = empty;
                  setDraftEdits(empty);
                  setUnsavedGuardOpen(false);
                  unsavedGuardCallbackRef.current?.();
                  unsavedGuardCallbackRef.current = null;
                }}
              >
                Discard changes
              </button>
              <button
                className={styles.unsavedGuardCancelBtn}
                onClick={() => setUnsavedGuardOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteZoneConfirm && (
        <div className={styles.unsavedGuardOverlay} onClick={() => setDeleteZoneConfirm(null)}>
          <div className={styles.unsavedGuardDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.unsavedGuardTitle}>Delete zone?</p>
            <p className={styles.unsavedGuardBody}>
              This will mark all {deleteZoneConfirm.rowIds.length} row{deleteZoneConfirm.rowIds.length !== 1 ? 's' : ''} in <strong>&ldquo;{deleteZoneConfirm.zoneName}&rdquo;</strong> for deletion. The changes won&apos;t be permanent until you save a new version.
            </p>
            <div className={styles.unsavedGuardActions}>
              <button className={styles.unsavedGuardSaveBtn} style={{ background: 'var(--danger-color, #dc2626)' }} onClick={handleDeleteZoneConfirm}>
                Yes, delete zone
              </button>
              <button className={styles.unsavedGuardCancelBtn} onClick={() => setDeleteZoneConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {versionDeleteConfirm && (
        <div className={styles.versionDeleteOverlay} onClick={() => { setVersionDeleteConfirm(null); setVersionDeleteError(null); }}>
          <div className={styles.versionDeleteDialog} onClick={(e) => e.stopPropagation()}>
            <p className={styles.versionDeleteDialogTitle}>Delete version?</p>
            <p className={styles.versionDeleteDialogBody}>
              This will permanently remove <strong>v{versions.find(v => v.id === versionDeleteConfirm)?.versionNumber}</strong> ({versions.find(v => v.id === versionDeleteConfirm)?.label}). This cannot be undone.
            </p>
            <div className={styles.versionDeleteDialogActions}>
              {versionDeleteError && (
                <p className={styles.versionDeleteErrMsg}>{versionDeleteError}</p>
              )}
              <button
                className={styles.versionDeleteCancelBtn}
                onClick={() => { setVersionDeleteConfirm(null); setVersionDeleteError(null); }}
                disabled={versionLoading}
              >
                Cancel
              </button>
              <button
                className={styles.versionDeleteConfirmBtn}
                onClick={() => deleteVersion(versionDeleteConfirm)}
                disabled={versionLoading}
              >
                {versionLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
