import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import MapView from './MapView.jsx';
import DataTable from './DataTable.jsx';

// Distance buckets for the GPS-vs-road-marker indicator.
export function distanceBucket(metres) {
  if (metres == null || !isFinite(metres)) return 'unknown';
  if (metres < 10) return 'good';
  if (metres < 50) return 'warn';
  return 'bad';
}

export default function FileDetail({ fileId }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [roadPositions, setRoadPositions] = useState({}); // measurementId → { lat, lon, distance_m, ref, error }
  const [snapBusy, setSnapBusy] = useState(false);
  const [toast, setToast] = useState(null); // { kind: 'ok'|'err'|'busy', text: string }

  // Status banner shown at the top of the page. 'busy' messages stay until
  // explicitly cleared; 'ok'/'err' auto-clear after 6 seconds. We keep
  // toasts long enough to be obvious — the user complaint was that snap
  // appeared to do nothing, so silence is the bug to avoid.
  const flash = (kind, text) => {
    setToast({ kind, text });
    if (kind !== 'busy') {
      setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 6000);
    }
  };
  const clearToast = () => setToast(null);

  const reload = useCallback(async () => {
    try {
      const f = await api.getFile(fileId);
      setFile(f);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [fileId]);

  useEffect(() => { reload(); }, [reload]);

  // After the file loads, fetch road-marker positions in the background.
  // Runs whenever the file's measurements change (e.g. after snapping).
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    api.roadPositions(file.id).then((positions) => {
      if (cancelled) return;
      const map = {};
      for (const p of positions) map[p.id] = p;
      setRoadPositions(map);
    }).catch((e) => {
      console.warn('road positions failed', e.message);
    });
    return () => { cancelled = true; };
  }, [file?.id, file?.measurements?.length, file?.updated_at]);

  const handleCellEdited = (measurementId, updated) => {
    setFile((prev) => prev && ({
      ...prev,
      measurements: prev.measurements.map((m) =>
        m.id === measurementId
          ? { ...m, cells: updated.cells, lat: updated.lat, lon: updated.lon }
          : m
      ),
    }));
  };

  const handleDeleteRow = async (measurementId, rowNum) => {
    try {
      await api.deleteMeasurement(measurementId);
      // Optimistic local update so the row disappears immediately. The
      // reload() below brings the authoritative state back from the server
      // and refreshes road-position lookups for the surviving rows.
      setFile((prev) => prev && ({
        ...prev,
        measurements: prev.measurements.filter((m) => m.id !== measurementId),
      }));
      if (selectedId === measurementId) setSelectedId(null);
      await reload();
      flash('ok', `✓ Row ${rowNum} deleted.`);
    } catch (e) {
      console.error('[delete-row] failed', e);
      flash('err', `Delete failed: ${e.message}`);
    }
  };

  const onSnapOne = async (measurementId, manualRef) => {
    const url = `/api/measurements/${measurementId}/snap`;
    console.log('[snap] POST', url, manualRef ? `(manual ref: ${manualRef})` : '');
    flash('busy', `Snapping row…  (POST ${url}${manualRef ? ` ref="${manualRef}"` : ''})`);
    try {
      const updated = await api.snapOne(measurementId, manualRef);
      console.log('[snap] server returned', updated);
      if (!updated || !Array.isArray(updated.cells)) {
        throw new Error('server response missing cells array — got: ' + JSON.stringify(updated));
      }
      handleCellEdited(measurementId, updated);
      await reload();
      try {
        const positions = await api.roadPositions(file.id);
        const map = {};
        for (const p of positions) map[p.id] = p;
        setRoadPositions(map);
      } catch (rpErr) {
        console.warn('[snap] road-positions refresh failed (harmless)', rpErr);
      }
      const rowNum = file.measurements.find((m) => m.id === measurementId)?.position + 1;
      // Use the server's authoritative `gps` field — falls back to the cell
      // it wrote in case the server is on an older build.
      const writtenGps = updated.gps
        || (Number.isInteger(updated.gpsColIndex) ? updated.cells[updated.gpsColIndex] : null)
        || '(check GPS column manually)';
      flash('ok', `✓ Row ${rowNum || '?'} snapped to ${updated.kortform || updated.ref}. GPS now: ${writtenGps}`);
    } catch (e) {
      console.error('[snap] failed', e);
      flash('err', `Snap failed: ${e.message}  (open DevTools → Network tab to see the request)`);
    }
  };

  const onSnapAll = async (opts) => {
    if (snapBusy) return;
    setSnapBusy(true);
    try {
      const result = await api.snapAll(file.id, opts || {});
      flash(
        result.failed ? 'err' : 'ok',
        `Snapped ${result.snapped} row${result.snapped === 1 ? '' : 's'}` +
        (result.skipped ? `, skipped ${result.skipped}` : '') +
        (result.failed ? `, failed ${result.failed}` : '') + '.'
      );
      await reload();
    } catch (e) {
      console.error('snap-all failed', e);
      flash('err', 'Snap-all failed: ' + e.message);
    } finally {
      setSnapBusy(false);
    }
  };

  const measurementsWithGps = useMemo(
    () => (file ? file.measurements.filter((m) => m.lat != null && m.lon != null) : []),
    [file]
  );

  // Build the road-marker overlay points for the map.
  const roadMarkers = useMemo(() => {
    if (!file) return [];
    return file.measurements
      .map((m) => ({ ...roadPositions[m.id], measurement: m }))
      .filter((p) => p && p.lat != null && p.lon != null);
  }, [file, roadPositions]);

  if (error) return <p style={{ color: 'var(--bad)' }}>Error: {error}</p>;
  if (!file) return <p className="muted">Loading…</p>;

  // Quick stats for the header bar.
  const distances = file.measurements
    .map((m) => roadPositions[m.id]?.distance_m)
    .filter((d) => d != null && isFinite(d));
  const matched = distances.length;
  const worst = distances.length ? Math.max(...distances) : null;

  return (
    <div>
      <div className="detail-header" style={{
        marginBottom: '0.5rem', borderRadius: 8, border: '1px solid var(--border)'
      }}>
        <div>
          <h2>{file.filename}</h2>
          <div className="muted">
            Device {file.serial} · v{file.version} · {file.measurements.length} measurements
            {measurementsWithGps.length < file.measurements.length && (
              <> · <span style={{ color: 'var(--warn)' }}>
                {file.measurements.length - measurementsWithGps.length} without GPS
              </span></>
            )}
            {matched > 0 && (
              <> · {matched} road-matched · worst gap{' '}
                <span className={'distance-' + distanceBucket(worst)}>
                  {worst.toFixed(0)} m
                </span>
              </>
            )}
          </div>
          {toast && (
            <div
              style={{
                marginTop: '0.4rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 6,
                background:
                  toast.kind === 'ok'  ? '#e6f4ea' :
                  toast.kind === 'err' ? '#fde8e8' :
                                         '#fef9c3',
                color:
                  toast.kind === 'ok'  ? '#216e39' :
                  toast.kind === 'err' ? '#9b1c1c' :
                                         '#854d0e',
                border: '1px solid ' + (
                  toast.kind === 'ok'  ? '#a3d9b1' :
                  toast.kind === 'err' ? '#f5a5a5' :
                                         '#fde68a'
                ),
                fontSize: '0.9rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <span style={{ flex: 1 }}>{toast.text}</span>
              <button
                onClick={clearToast}
                className="ghost"
                style={{ padding: '0.1rem 0.4rem', fontSize: '0.75rem' }}
              >
                dismiss
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            disabled={snapBusy}
            onClick={() => {
              if (confirm('Snap every row to its NVDB road marker, including ones already close. Continue?')) {
                onSnapAll({});
              }
            }}
          >
            Snap all
          </button>
          <a href={api.exportUrl(file.id)}>
            <button>Export .pqidat</button>
          </a>
        </div>
      </div>

      <div className="detail">
        <div className="map-pane">
          <div className="detail-header">
            <strong>Map (Kartverket Norway)</strong>
            <span className="muted">
              <span style={{ color: 'var(--accent)' }}>●</span> recorded GPS &nbsp;
              <span style={{ color: '#9333ea' }}>◆</span> road marker &nbsp;
              <span style={{ color: '#0ea5e9' }}>◆</span> click any spot to look up road marker
            </span>
          </div>
          <MapView
            headers={file.headers}
            measurements={measurementsWithGps}
            roadMarkers={roadMarkers}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
        <div className="table-pane">
          <DataTable
            headers={file.headers}
            measurements={file.measurements}
            roadPositions={roadPositions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCellEdited={handleCellEdited}
            onSnapOne={onSnapOne}
            onDeleteRow={handleDeleteRow}
          />
        </div>
      </div>
    </div>
  );
}
