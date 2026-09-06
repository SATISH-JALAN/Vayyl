// ============================================================
// Drawing tool registry
// ============================================================
// Each button on the chart's left rail maps to a KLineChart overlay template.
// The mapping lives here, as data, for one reason: a template name that no
// longer exists makes `createOverlay` return null and the button becomes a
// SILENT no-op -- the click does nothing, nothing throws, and nothing logs.
// `chart-tools.test.ts` asks the installed library for its real template list
// and fails if any id below is missing.
//
// Verified against klinecharts 10.0.3. `rect` and `circle` are FIGURES, not
// overlays, and are deliberately absent -- they cannot be drawn this way.

/** A tool that draws something. `overlay` is a klinecharts template name. */
export interface DrawingTool {
  id: string;
  label: string;
  overlay: string;
}

/** One button on the rail. Either a single tool or a group opened by the button. */
export interface ToolGroup {
  id: string;
  label: string;
  /** Which stroke-icon to render. Kept out of here so this file stays testable. */
  icon: string;
  tools: DrawingTool[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'trend',
    label: 'Trend line',
    icon: 'trend',
    tools: [
      { id: 'segment', label: 'Trend line', overlay: 'segment' },
      { id: 'rayLine', label: 'Ray', overlay: 'rayLine' },
      { id: 'straightLine', label: 'Extended line', overlay: 'straightLine' },
    ],
  },
  {
    // One rail button for every straight level, horizontal and vertical. The
    // design shows nine icons; this keeps all sixteen overlay templates
    // reachable without adding a tenth.
    id: 'lines',
    label: 'Horizontal & vertical lines',
    icon: 'lines',
    tools: [
      { id: 'horizontalStraightLine', label: 'Horizontal line', overlay: 'horizontalStraightLine' },
      { id: 'horizontalRayLine', label: 'Horizontal ray', overlay: 'horizontalRayLine' },
      { id: 'horizontalSegment', label: 'Horizontal segment', overlay: 'horizontalSegment' },
      // Draws its own price label on the axis, which is what makes it useful
      // for marking a level you are watching rather than just a line.
      { id: 'priceLine', label: 'Price line', overlay: 'priceLine' },
      { id: 'verticalStraightLine', label: 'Vertical line', overlay: 'verticalStraightLine' },
      { id: 'verticalRayLine', label: 'Vertical ray', overlay: 'verticalRayLine' },
      { id: 'verticalSegment', label: 'Vertical segment', overlay: 'verticalSegment' },
    ],
  },
  {
    id: 'channel',
    label: 'Channel',
    icon: 'channel',
    tools: [
      { id: 'parallelStraightLine', label: 'Parallel channel', overlay: 'parallelStraightLine' },
      { id: 'priceChannelLine', label: 'Price channel', overlay: 'priceChannelLine' },
    ],
  },
  {
    id: 'fib',
    label: 'Fibonacci retracement',
    icon: 'fib',
    tools: [{ id: 'fibonacciLine', label: 'Fibonacci retracement', overlay: 'fibonacciLine' }],
  },
  {
    id: 'text',
    label: 'Text',
    icon: 'text',
    tools: [{ id: 'simpleTag', label: 'Text tag', overlay: 'simpleTag' }],
  },
  {
    id: 'emoji',
    label: 'Annotation',
    icon: 'emoji',
    tools: [{ id: 'simpleAnnotation', label: 'Annotation', overlay: 'simpleAnnotation' }],
  },
  {
    id: 'brush',
    label: 'Brush',
    icon: 'brush',
    tools: [{ id: 'brush', label: 'Freehand brush', overlay: 'brush' }],
  },
];

/** Every tool, flattened. */
export const ALL_TOOLS: DrawingTool[] = TOOL_GROUPS.flatMap((g) => g.tools);

/**
 * Group ids used to tell the user's drawings apart from Vayyl's own lines.
 *
 * The rail's clear button removes `USER` only. Without this, "clear drawings"
 * would also wipe the oracle, entry and liquidation overlays -- the three lines
 * on the chart that are not decoration -- and they would not come back until
 * the next 30-second refresh happened to change one of them.
 */
export const OVERLAY_GROUP = {
  USER: 'vy-user',
  VAYYL: 'vy-protocol',
} as const;

export function findTool(id: string): DrawingTool | null {
  return ALL_TOOLS.find((t) => t.id === id) ?? null;
}
