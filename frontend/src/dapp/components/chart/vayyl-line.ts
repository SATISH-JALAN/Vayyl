// ============================================================
// Vayyl's own price-line overlay template
// ============================================================
// WHY THIS EXISTS. KLineChart's built-in `priceLine` draws its label inside
// `createPointFigures`, at `coordinates[0].x`. Our lines are placed by VALUE
// with no timestamp -- there is no bar they belong to -- so that x resolves to
// 0 and the label lands as a badge against the LEFT edge of the chart, opposite
// the real price axis. Two price labels, two different numbers, two different
// sides. `needDefaultYAxisFigure: false` does not help, because the label is a
// point figure the template draws itself, not the default axis figure.
//
// So we register our own: a line straight across, and the label at the RIGHT,
// beside the axis where every other price on this chart is read.
//
// Registered once, lazily, from inside the engine's dynamic import -- this
// module must never pull klinecharts in at module scope or it takes server
// rendering down with it.

export const VAYYL_LINE = 'vayylPriceLine';

/** Label padding and box metrics, in px. */
const PAD_X = 6;
const PAD_Y = 3;
const FONT_SIZE = 11;
const GAP = 6;

interface Coordinate {
  x: number;
  y: number;
}

/**
 * Build the template.
 *
 * Takes the registrar rather than importing it, so this file stays free of any
 * klinecharts import. `extendData` carries the label text and `styles.line`
 * carries the colour, both supplied by the engine's reconciler.
 */
export function registerVayylLine(register: (template: unknown) => void): void {
  register({
    name: VAYYL_LINE,
    totalStep: 2,
    // Not draggable: these are protocol values, not annotations. A user who
    // could drag the liquidation line would be moving a number the contract
    // owns.
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({
      coordinates,
      bounding,
      overlay,
    }: {
      coordinates: Coordinate[];
      bounding: { width: number; height: number };
      overlay: { extendData?: unknown; styles?: { line?: { color?: string } } };
    }) => {
      const point = coordinates[0];
      if (!point) return [];

      const label = typeof overlay.extendData === 'string' ? overlay.extendData : '';
      const color = overlay.styles?.line?.color ?? '#d3a35f';
      const figures: Array<Record<string, unknown>> = [
        {
          type: 'line',
          ignoreEvent: true,
          attrs: {
            coordinates: [
              { x: 0, y: point.y },
              { x: bounding.width, y: point.y },
            ],
          },
        },
      ];

      if (label) {
        // Right-aligned against the price axis. `text` figures in klinecharts
        // take a baseline x, so the box is drawn from the right edge inward.
        const width = label.length * (FONT_SIZE * 0.6) + PAD_X * 2;
        figures.push({
          type: 'text',
          ignoreEvent: true,
          attrs: {
            x: Math.max(0, bounding.width - width - GAP),
            y: point.y - (FONT_SIZE / 2 + PAD_Y),
            text: label,
            align: 'left',
            baseline: 'top',
          },
          styles: {
            color: '#12100f',
            size: FONT_SIZE,
            family: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            paddingLeft: PAD_X,
            paddingRight: PAD_X,
            paddingTop: PAD_Y,
            paddingBottom: PAD_Y,
            borderRadius: 2,
            backgroundColor: color,
          },
        });
      }

      return figures;
    },
  });
}
