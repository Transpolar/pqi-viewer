import React, { useState } from 'react';
import { api } from './api.js';
import { distanceBucket } from './FileDetail.jsx';

// Click any cell to edit it; Enter commits, Escape cancels.
// The "Road match" column shows:
//   - the assembled road reference (always, if one exists for the row)
//   - the distance to the NVDB position (once the preview lookup finishes)
//   - a Snap button that ALWAYS works as long as the row has a road ref
//     (it does its own NVDB call; the preview is purely informational).
export default function DataTable({
  headers,
  measurements,
  roadPositions,
  selectedId,
  onSelect,
  onCellEdited,
  onSnapOne,
  onDeleteRow,
}) {
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [snappingId, setSnappingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const handleDelete = async (m, e) => {
    if (e) e.stopPropagation();
    const rowNum = m.position + 1;
    if (!confirm(`Delete row ${rowNum}? This removes it from the file and can't be undone (re-upload the original .pqidat to restore).`)) return;
    setDeletingId(m.id);
    try {
      await onDeleteRow(m.id, rowNum);
    } finally {
      setDeletingId(null);
    }
  };

  const compactionIdx = headers.findIndex((h) => h.trim().toLowerCase() === 'kompaktering');

  const commit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const updated = await api.updateCell(
        editing.measurementId,
        editing.columnIndex,
        editing.value
      );
      onCellEdited(editing.measurementId, updated);
      setEditing(null);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setEditing(null); setError(null); };

  // Manual-ref text per row, keyed by measurement id. Persists while the
  // user types; cleared after a successful manual snap.
  const [manualRefs, setManualRefs] = useState({});

  const handleSnap = async (m, manualRef) => {
    setSnappingId(m.id);
    try {
      await onSnapOne(m.id, manualRef || undefined);
      if (manualRef) setManualRefs((prev) => ({ ...prev, [m.id]: '' }));
    } finally {
      setSnappingId(null);
    }
  };

  return (
    <>
      {error && <div style={{ padding: '0.5rem', color: 'var(--bad)' }}>Save error: {error}</div>}
      <table className="measurements">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th style={{ width: 230 }}>Road match</th>
            {headers.map((h, i) => <th key={i}>{h}</th>)}
            <th style={{ width: 44 }} title="Delete row"></th>
          </tr>
        </thead>
        <tbody>
          {measurements.map((m) => {
            const rp = roadPositions ? roadPositions[m.id] : undefined;
            const hasRef = !!m.roadRef;
            return (
              <tr
                key={m.id}
                className={selectedId === m.id ? 'selected' : ''}
                onClick={() => onSelect && onSelect(m.id)}
              >
                <td className="muted">{m.position + 1}</td>
                <td>
                  <RoadMatchCell
                    measurement={m}
                    hasRef={hasRef}
                    rp={rp}
                    snapping={snappingId === m.id}
                    manualRef={manualRefs[m.id] || ''}
                    onManualRefChange={(v) =>
                      setManualRefs((prev) => ({ ...prev, [m.id]: v }))
                    }
                    onSnap={(e, manual) => { if (e) e.stopPropagation(); handleSnap(m, manual); }}
                  />
                </td>
                {headers.map((h, colIdx) => {
                  const isEditing =
                    editing &&
                    editing.measurementId === m.id &&
                    editing.columnIndex === colIdx;
                  const value = m.cells[colIdx] ?? '';
                  const isCompaction = colIdx === compactionIdx && value !== '';
                  const compactionClass = isCompaction
                    ? compactionClassFor(parseFloat(value))
                    : '';

                  if (isEditing) {
                    return (
                      <td key={colIdx} className="editing">
                        <input
                          autoFocus
                          disabled={saving}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit();
                            if (e.key === 'Escape') cancel();
                          }}
                          onBlur={commit}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={colIdx}
                      className={'editable ' + compactionClass}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect && onSelect(m.id);
                        setEditing({ measurementId: m.id, columnIndex: colIdx, value });
                      }}
                    >
                      {value || <span className="muted">—</span>}
                    </td>
                  );
                })}
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={(e) => handleDelete(m, e)}
                    disabled={deletingId === m.id}
                    title={`Delete row ${m.position + 1}`}
                    style={{
                      padding: '0.1rem 0.5rem',
                      fontSize: '0.85rem',
                      lineHeight: 1.1,
                      background: deletingId === m.id ? '#999' : 'transparent',
                      color: deletingId === m.id ? 'white' : 'var(--bad)',
                      border: '1px solid var(--bad)',
                      borderRadius: 3,
                      cursor: deletingId === m.id ? 'wait' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    {deletingId === m.id ? '…' : '×'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function RoadMatchCell({
  measurement: m, hasRef, rp, snapping, manualRef, onManualRefChange, onSnap,
}) {
  // No auto-detected reference → let the user type one manually and snap.
  if (!hasRef) {
    const missing = Array.isArray(m.missingForRef) && m.missingForRef.length
      ? m.missingForRef.join(', ')
      : '—';
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}
      >
        <span className="muted" style={{ fontSize: '0.7rem' }} title={`Missing: ${missing}`}>
          auto failed — missing: {missing}
        </span>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          <input
            type="text"
            value={manualRef}
            onChange={(e) => onManualRefChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualRef.trim()) onSnap(e, manualRef.trim());
            }}
            placeholder="e.g. 9999 KV1234 S1D1 m100"
            style={{
              fontSize: '0.75rem',
              padding: '0.15rem 0.3rem',
              border: '1px solid var(--border)',
              borderRadius: 3,
              width: 180,
            }}
          />
          <button
            disabled={snapping || !manualRef.trim()}
            onClick={(e) => onSnap(e, manualRef.trim())}
            style={{
              padding: '0.15rem 0.5rem',
              fontSize: '0.75rem',
              background: snapping ? '#999' : '#2d6cdf',
              color: 'white',
              border: 'none',
              borderRadius: 3,
              cursor: snapping || !manualRef.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {snapping ? '…' : 'Snap'}
          </button>
        </div>
      </div>
    );
  }

  // We always show the Snap button when a ref exists. The NVDB preview is
  // additional info; if it hasn't returned yet (or failed), the button
  // still does the lookup on demand and reports the result.
  let status;
  if (rp === undefined) {
    status = <span className="muted" style={{ fontSize: '0.75rem' }}>checking…</span>;
  } else if (rp?.error) {
    status = (
      <span className="distance-bad" style={{ fontSize: '0.75rem' }} title={rp.error}>
        NVDB: {rp.error}
      </span>
    );
  } else if (rp?.distance_m == null) {
    status = (
      <span className="muted" style={{ fontSize: '0.75rem' }}>
        no GPS to compare
      </span>
    );
  } else {
    const bucket = distanceBucket(rp.distance_m);
    status = (
      <span className={'distance-' + bucket} style={{ fontSize: '0.8rem', fontWeight: 600 }}>
        {rp.distance_m < 1
          ? `${(rp.distance_m * 100).toFixed(0)} cm`
          : `${rp.distance_m.toFixed(0)} m off`}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
      {status}
      <button
        style={{
          padding: '0.2rem 0.7rem',
          fontSize: '0.8rem',
          fontWeight: 600,
          background: snapping ? '#999' : '#2d6cdf',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          cursor: snapping ? 'wait' : 'pointer',
        }}
        disabled={snapping}
        onClick={onSnap}
        title={`Snap GPS to ${m.roadRef}`}
      >
        {snapping ? 'snapping…' : '↳ Snap'}
      </button>
      <span className="muted" style={{ fontSize: '0.7rem' }}>{m.roadRef}</span>
      {m.sectionDefaulted && (
        <span
          className="muted"
          style={{ fontSize: '0.65rem', fontStyle: 'italic' }}
          title="Sted på veien didn't include a section — defaulted to S1D1. If snap returns the wrong road, append e.g. S2D1 to the Sted på veien cell."
        >
          (section S1D1)
        </span>
      )}
      {m.kommuneInferred && (
        <span
          style={{ fontSize: '0.65rem', fontStyle: 'italic', color: 'var(--accent)' }}
          title="Sted på veien was missing the kommune prefix — filled in from sibling rows in the same file."
        >
          (kommune inferred)
        </span>
      )}
    </div>
  );
}

function compactionClassFor(v) {
  if (isNaN(v)) return '';
  if (v >= 96) return 'compaction-good';
  if (v >= 92) return 'compaction-warn';
  return 'compaction-bad';
}
