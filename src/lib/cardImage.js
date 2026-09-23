// Draws the holo card onto a 1080×1350 canvas (Instagram 4:5) and returns a PNG blob.
// Layout is in the card's own CSS-pixel space (320 wide) and scaled up, mirroring HoloCard.astro.

const W = 320;
const H = (W * 88) / 63;
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const RAINBOW = ['#ff7773', '#ffed5f', '#a8ff5f', '#83fff7', '#7894ff', '#d875ff'];

// card: { device, modelId, build, score, stars, rows: [{ k, v, rank }] }
export function drawCard(card) {
  const css = getComputedStyle(document.documentElement);
  const c = (name) => css.getPropertyValue(name).trim();
  const color = { fg: c('--fg'), muted: c('--muted'), card: c('--card'), line: c('--line'), 高: c('--high'), 中: c('--mid'), 低: c('--low') };

  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = color.muted;
  ctx.font = `500 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('iPhone 零件鑑定卡', canvas.width / 2, 1318);

  const s = 860 / W;
  ctx.translate((canvas.width - W * s) / 2, 40);
  ctx.scale(s, s);

  const box = (x, y, w, h, r, fill) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const text = (t, x, y, font, fill, align = 'left') => {
    ctx.font = font;
    ctx.fillStyle = fill;
    ctx.textAlign = align;
    ctx.fillText(t, x, y);
  };
  const fit = (t, w) => {
    if (ctx.measureText(t).width <= w) return t;
    while (t && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  };

  box(0, 0, W, H, 18, color.fg);
  box(10, 10, W - 20, H - 20, 10, '#fff');
  const x0 = 22, x1 = W - 22;

  // Top: kicker + overall score
  text('零件鑑定卡', x0, 44, `700 12px ${FONT}`, color.muted);
  text(card.score ?? '—', x1, 46, `700 28px ${FONT}`, color.fg, 'right');
  const scoreW = ctx.measureText(String(card.score ?? '—')).width;
  text('總評', x1 - scoreW - 4, 46, `600 11px ${FONT}`, color.muted, 'right');

  // Foot
  const footY = H - 24;
  text(card.build ? `iOS Build ${card.build}` : '', x0, footY, `11px ${FONT}`, color.muted);
  text(card.stars, x1, footY, `11px ${FONT}`, color.fg, 'right');

  // Rows ("moves"), stacked up from the foot
  const rowH = 22;
  const rowsTop = footY - 18 - card.rows.length * rowH;
  card.rows.forEach((r, i) => {
    const y = rowsTop + i * rowH;
    if (i) {
      ctx.fillStyle = color.card;
      ctx.fillRect(x0, y - 4, x1 - x0, 1);
    }
    text(r.k, x0, y + 12, `600 12px ${FONT}`, color.muted);
    ctx.font = `700 12px ${FONT}`;
    const rankW = ctx.measureText(r.rank).width + 11;
    text(r.rank, x1, y + 12, `700 12px ${FONT}`, color.fg, 'right');
    ctx.beginPath();
    ctx.arc(x1 - rankW + 3.5, y + 8, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color[r.rank] || color.line;
    ctx.fill();
    ctx.font = `600 12px ${FONT}`;
    text(fit(r.v, x1 - rankW - 8 - (x0 + 46)), x0 + 46, y + 12, `600 12px ${FONT}`, color.fg);
  });

  // Art window: model name on black, with a frozen slice of the holo foil
  const artY = 58, artH = rowsTop - 12 - artY;
  box(x0, artY, x1 - x0, artH, 8, color.fg);
  const foil = ctx.createLinearGradient(x0, artY, x1, artY + artH);
  const stops = [...RAINBOW, ...RAINBOW, RAINBOW[0]];
  stops.forEach((col, i) => foil.addColorStop(i / (stops.length - 1), col));
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.4;
  box(x0, artY, x1 - x0, artH, 8, foil);
  ctx.restore();
  const cy = artY + artH / 2;
  ctx.font = `700 28px ${FONT}`;
  text(fit(card.device, x1 - x0 - 24), W / 2, cy + 4, `700 28px ${FONT}`, '#fff', 'center');
  ctx.globalAlpha = 0.6;
  text(card.modelId ?? '', W / 2, cy + 26, `12px ${MONO}`, '#fff', 'center');
  ctx.globalAlpha = 1;

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
