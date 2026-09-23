// Persistent board-existence memory for reverse ATS sweeps (#2840).
// Only a real "no such board" answer may advance a miss counter — an HTTP 404,
// or the ATS-specific equivalent in NOT_FOUND_STATUS below. Throttles,
// transport failures and DNS errors mean "unknown", never "dead".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEAD_BOARD_HEADER = 'ats\tboard\tmisses\tlast_checked';
export const DEAD_BOARD_MISSES = 3;
export const DEAD_BOARD_RECHECK_DAYS = 30;

function key(ats, board) { return `${ats}\t${board}`; }

// The status each ATS uses to say a board does not exist. 404 everywhere,
// plus Workday's 422: its CXS API answers a tenant or site that no longer
// exists with HTTP 422 and an empty-message body, never 404. Measured
// 2026-09-23 on a deterministic sample of 30 tenants: 15 returned 422, all 15
// returned it again on a repeat request, and none of the 15 still had a live
// public careers page — while the same request body got a 200 from every live
// tenant in the sample. Before this, only 120 of ~7,000 unreachable Workday
// tenants ever entered the ledger, so every sweep re-contacted all of them.
//
// Scoped per ATS on purpose. A 422 from another provider can mean a malformed
// query, and treating that as "dead" would retire live boards.
const NOT_FOUND_STATUS = { workday: new Set([404, 422]) };

/** True when `status` is `ats`'s definitive "this board does not exist". */
export function isBoardNotFound(ats, status) {
  const statuses = NOT_FOUND_STATUS[ats];
  return statuses ? statuses.has(status) : status === 404;
}

export function loadDeadBoards(file, now = Date.now()) {
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    const [ats, board, missesRaw, checked] = line.split('\t');
    const misses = Number(missesRaw);
    const lastChecked = Date.parse(checked || '');
    if (!ats || !board || !Number.isInteger(misses) || misses < 1 || !Number.isFinite(lastChecked)) continue;
    rows.set(key(ats, board), { ats, board, misses, lastChecked, now });
  }
  return rows;
}

export function boardKey(entry) {
  return String(entry?.careers_url || entry?.name || '').trim();
}

export function shouldSkipDeadBoard(rows, ats, board, now = Date.now()) {
  const row = rows.get(key(ats, board));
  return Boolean(row && row.misses >= DEAD_BOARD_MISSES && now - row.lastChecked < DEAD_BOARD_RECHECK_DAYS * 86_400_000);
}

export function recordBoardResult(rows, ats, board, status, now = Date.now()) {
  const rowKey = key(ats, board);
  if (status === 200) {
    rows.delete(rowKey);
    return;
  }
  const previous = rows.get(rowKey);
  if (!isBoardNotFound(ats, status)) {
    if (!previous || previous.misses < DEAD_BOARD_MISSES) {
      rows.delete(rowKey);
    } else {
      rows.set(rowKey, { ...previous, lastChecked: now });
    }
    return;
  }
  const misses = Math.min(DEAD_BOARD_MISSES, (previous?.misses || 0) + 1);
  rows.set(rowKey, { ats, board, misses, lastChecked: now });
}

export function saveDeadBoards(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const body = [...rows.values()]
    .sort((a, b) => a.ats.localeCompare(b.ats) || a.board.localeCompare(b.board))
    .map((row) => `${row.ats}\t${row.board}\t${row.misses}\t${new Date(row.lastChecked).toISOString()}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${DEAD_BOARD_HEADER}\n${body.length ? `${body.join('\n')}\n` : ''}`, 'utf8');
  renameSync(tmp, file);
}
