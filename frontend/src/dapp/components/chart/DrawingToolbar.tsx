'use client';

import { useRef, useState } from 'react';

import ChartIcon from './ChartIcons';
import { useDismiss } from '../common/useDismiss';
import { OVERLAY_GROUP, TOOL_GROUPS, type DrawingTool } from './chart-tools';
import type { ChartApi } from './engine';

/**
 * The vertical drawing rail.
 *
 * Nine buttons, matching the circulated design: cursor, then the seven overlay
 * groups from `chart-tools.ts`, then zoom. Every one drives KLineChart's real
 * API — `createOverlay` puts the chart into drawing mode and the next clicks on
 * the canvas place the points. Nothing here is a mock: the template names are
 * checked against the installed library on every test run, precisely because a
 * wrong name makes the button do nothing at all, silently.
 *
 * The cursor button cancels an in-progress drawing rather than being
 * decorative. Without it, arming a tool by mistake leaves the chart waiting for
 * clicks with no way back except drawing the thing you did not want.
 *
 * Clearing drawings lives in the settings menu, not here, because the design
 * has nine icons and a tenth would be visible drift.
 */
export default function DrawingToolbar({ api }: { api: ChartApi | null }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  useDismiss(openGroup !== null, railRef, () => setOpenGroup(null));

  const cancelPending = () => {
    // An overlay that never received all its points still exists on the chart,
    // so switching tools without this leaves a half-drawn shape behind.
    if (pendingRef.current && api) api.removeOverlay({ id: pendingRef.current });
    pendingRef.current = null;
  };

  const arm = (tool: DrawingTool) => {
    if (!api) return;
    cancelPending();
    const created = api.createOverlay({ name: tool.overlay, groupId: OVERLAY_GROUP.USER });
    if (typeof created === 'string') pendingRef.current = created;
    setActiveTool(tool.id);
    setOpenGroup(null);
  };

  const toCursor = () => {
    cancelPending();
    setActiveTool(null);
    setOpenGroup(null);
  };

  const zoom = (scale: number) => {
    api?.zoomAtCoordinate(scale);
    setOpenGroup(null);
  };

  const resetView = () => {
    api?.scrollToRealTime();
    setOpenGroup(null);
  };

  const disabled = api === null;

  return (
    <div
      className="vy-rail"
      ref={railRef}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Drawing tools"
    >
      <button
        type="button"
        className={`vy-rail__btn ${activeTool === null ? 'is-active' : ''}`}
        onClick={toCursor}
        disabled={disabled}
        title="Cursor — cancels an in-progress drawing"
        aria-pressed={activeTool === null}
      >
        <ChartIcon name="cursor" />
      </button>

      {TOOL_GROUPS.map((group) => {
        const isActive = group.tools.some((t) => t.id === activeTool);
        const single = group.tools.length === 1;
        return (
          <div key={group.id} className="vy-rail__group">
            <button
              type="button"
              className={`vy-rail__btn ${isActive ? 'is-active' : ''}`}
              disabled={disabled}
              title={group.label}
              aria-pressed={isActive}
              aria-haspopup={single ? undefined : 'menu'}
              aria-expanded={single ? undefined : openGroup === group.id}
              onClick={() =>
                single
                  ? arm(group.tools[0])
                  : setOpenGroup((v) => (v === group.id ? null : group.id))
              }
            >
              <ChartIcon name={group.icon} />
              {!single && <i className="vy-rail__more" aria-hidden="true" />}
            </button>

            {openGroup === group.id && (
              <div className="vy-rail__menu" role="menu">
                {group.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    role="menuitem"
                    className={activeTool === tool.id ? 'is-active' : ''}
                    onClick={() => arm(tool)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="vy-rail__group">
        <button
          type="button"
          className="vy-rail__btn"
          disabled={disabled}
          title="Zoom"
          aria-haspopup="menu"
          aria-expanded={openGroup === 'zoom'}
          onClick={() => setOpenGroup((v) => (v === 'zoom' ? null : 'zoom'))}
        >
          <ChartIcon name="zoom" />
          <i className="vy-rail__more" aria-hidden="true" />
        </button>

        {openGroup === 'zoom' && (
          <div className="vy-rail__menu" role="menu">
            {/* Positive scales in, negative out. Anchored at the chart's own
                zoom anchor rather than a coordinate, so it behaves like the
                scroll-wheel zoom the user already has. */}
            <button type="button" role="menuitem" onClick={() => zoom(0.5)}>
              Zoom in
            </button>
            <button type="button" role="menuitem" onClick={() => zoom(-0.5)}>
              Zoom out
            </button>
            <button type="button" role="menuitem" onClick={resetView}>
              Jump to latest
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
