export type PairEditOperation =
  | {
      operationId?: string;
      type: 'swap_adjuster_side' | 'swap_yours_side' | 'pair_rows';
      rowAId: string;
      rowBId: string;
      reason?: string;
    }
  | {
      operationId?: string;
      type: 'unpair_row';
      rowId: string;
      keepSide: 'yours' | 'adjuster';
      reason?: string;
    };

export type PairEditRowSnapshot = {
  id: string;
  hasYoursSide: boolean;
  hasAdjusterSide: boolean;
};

export type PairEditValidationError = {
  index: number;
  message: string;
};

export type PairEditValidationResult = {
  accepted: PairEditOperation[];
  rejected: PairEditValidationError[];
};

function normalizeReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') {
    return undefined;
  }

  const trimmed = reason.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

function ensureString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOperation(input: unknown): PairEditOperation | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const source = input as Record<string, unknown>;
  const type = ensureString(source.type);

  if (!type) {
    return null;
  }

  const operationId = ensureString(source.operationId) ?? undefined;
  const reason = normalizeReason(typeof source.reason === 'string' ? source.reason : undefined);

  if (type === 'swap_adjuster_side' || type === 'swap_yours_side' || type === 'pair_rows') {
    const rowAId = ensureString(source.rowAId);
    const rowBId = ensureString(source.rowBId);

    if (!rowAId || !rowBId) {
      return null;
    }

    return {
      operationId,
      type,
      rowAId,
      rowBId,
      reason,
    };
  }

  if (type === 'unpair_row') {
    const rowId = ensureString(source.rowId);
    const keepSide = ensureString(source.keepSide);

    if (!rowId || (keepSide !== 'yours' && keepSide !== 'adjuster')) {
      return null;
    }

    return {
      operationId,
      type,
      rowId,
      keepSide,
      reason,
    };
  }

  return null;
}

export function validatePairEditOperations(
  operationsInput: unknown,
  rows: PairEditRowSnapshot[]
): PairEditValidationResult {
  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const accepted: PairEditOperation[] = [];
  const rejected: PairEditValidationError[] = [];
  const usedRowIds = new Set<string>();

  const operations = Array.isArray(operationsInput) ? operationsInput : [];

  operations.forEach((rawOperation, index) => {
    const operation = normalizeOperation(rawOperation);

    if (!operation) {
      rejected.push({
        index,
        message: 'Invalid operation payload.',
      });
      return;
    }

    if (operation.type === 'unpair_row') {
      const row = rowMap.get(operation.rowId);

      if (!row) {
        rejected.push({
          index,
          message: `Row not found: ${operation.rowId}`,
        });
        return;
      }

      if (!row.hasYoursSide || !row.hasAdjusterSide) {
        rejected.push({
          index,
          message: `Row cannot be unpaired because it is already single-sided: ${operation.rowId}`,
        });
        return;
      }

      if (usedRowIds.has(operation.rowId)) {
        rejected.push({
          index,
          message: `Row already referenced by another operation: ${operation.rowId}`,
        });
        return;
      }

      usedRowIds.add(operation.rowId);
      accepted.push(operation);
      return;
    }

    if (operation.rowAId === operation.rowBId) {
      rejected.push({
        index,
        message: 'rowAId and rowBId must be different.',
      });
      return;
    }

    const rowA = rowMap.get(operation.rowAId);
    const rowB = rowMap.get(operation.rowBId);

    if (!rowA || !rowB) {
      rejected.push({
        index,
        message: `One or more rows were not found: ${operation.rowAId}, ${operation.rowBId}`,
      });
      return;
    }

    if (usedRowIds.has(operation.rowAId) || usedRowIds.has(operation.rowBId)) {
      rejected.push({
        index,
        message: `A row is referenced by multiple operations: ${operation.rowAId}, ${operation.rowBId}`,
      });
      return;
    }

    if (operation.type === 'swap_adjuster_side' && (!rowA.hasAdjusterSide || !rowB.hasAdjusterSide)) {
      rejected.push({
        index,
        message: 'Both rows must have adjuster-side data for swap_adjuster_side.',
      });
      return;
    }

    if (operation.type === 'swap_yours_side' && (!rowA.hasYoursSide || !rowB.hasYoursSide)) {
      rejected.push({
        index,
        message: 'Both rows must have yours-side data for swap_yours_side.',
      });
      return;
    }

    if (operation.type === 'pair_rows') {
      const hasAnySingleSided = rowA.hasYoursSide !== rowA.hasAdjusterSide || rowB.hasYoursSide !== rowB.hasAdjusterSide;
      if (!hasAnySingleSided) {
        rejected.push({
          index,
          message: 'pair_rows expects at least one single-sided row in the pair.',
        });
        return;
      }
    }

    usedRowIds.add(operation.rowAId);
    usedRowIds.add(operation.rowBId);
    accepted.push(operation);
  });

  return { accepted, rejected };
}
