// Scan screen extras: drag-and-drop onto the upload box, and the gallery of kits with real 3D models.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Drag and drop: hand the dropped files to the same input main.js already listens to
const drop = $('drop');
['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
  event.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('over')));
drop.addEventListener('drop', event => {
  event.preventDefault();
  const files = [...event.dataTransfer.files].filter(f => f.type === 'application/pdf' || f.type.startsWith('image/'));
  if (!files.length) return;
  const list = new DataTransfer();
  files.forEach(f => list.items.add(f));
  $('files').files = list.files;
  $('files').dispatchEvent(new Event('change'));
});

// ---- Kit gallery
const ICONS = {
  Chairs: '<path d="M7 3v9h10V3M6 12h12v3H6zM7 15v6M17 15v6"/>',
  Tables: '<path d="M3 8h18v2H3zM5 10v10M19 10v10M8 10v5h8v-5"/>',
  Benches: '<path d="M3 11h18v2H3zM4 7h16M5 13v7M19 13v7M5 7v4M19 7v4"/>',
  Desks: '<path d="M3 7h18v2H3zM4 9v11M20 9v11M13 9v7h7"/><path d="M16 12h1"/>',
  Storage: '<path d="M5 3h14v18H5zM5 9h14M5 15h14M11 6h2M11 12h2M11 18h2"/>',
};
const ORIGINAL = {   // IKEA's own 3D Assembly Dataset kits, keyed by article number
  '30178884': ['Chairs', 'step stool'], '40463852': ['Chairs', 'step stool'], '60155602': ['Chairs', 'bar stool'],
  '00333947': ['Storage', ''], '70332124': ['Storage', ''], '30449908': ['Tables', ''],
};
const FROM_KEY = { chair: 'Chairs', table: 'Tables', bench: 'Benches', desk: 'Desks', shelf: 'Storage', misc: 'Storage' };

function describe(kit) {
  const key = kit.article_number;
  if (ORIGINAL[key]) {
    const [type, extra] = ORIGINAL[key];
    return { type, title: extra && !kit.name.includes(' ') ? `${kit.name} ${extra}` : kit.name, source: 'IKEA 3D' };
  }
  const type = FROM_KEY[key.split('-')[1]] || 'Storage';
  return { type, title: kit.name.replace(/ misc$/, ''), source: 'IKEA-Manual' };
}

let kits = [], filter = 'All';
function render() {
  const query = $('kitSearch').value.trim().toLowerCase();
  const shown = kits.filter(k => (filter === 'All' || k.type === filter)
    && (!query || `${k.title} ${k.type} ${k.source}`.toLowerCase().includes(query)));
  $('kitGrid').innerHTML = shown.length ? shown.map(k => `
    <a class="kit" href="/kits.html?kit=${encodeURIComponent(k.article_number)}">
      <span class="art" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[k.type]}</svg></span>
      <b>${esc(k.title)}</b>
      <span class="meta"><span>${k.mesh_nodes} parts</span><span class="src">${esc(k.source)}</span></span>
    </a>`).join('') : '<div class="empty">No furniture matches that search.</div>';
}

fetch('/api/kits').then(r => r.json()).then(list => {
  kits = list.map(k => ({ ...k, ...describe(k) }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
  const types = ['All', ...Object.keys(ICONS).filter(t => kits.some(k => k.type === t))];
  $('kitFilters').innerHTML = types.map(t =>
    `<button type="button" aria-pressed="${t === filter}" data-type="${t}">${t}${t === 'All' ? ` · ${kits.length}` : ''}</button>`).join('');
  $('kitFilters').onclick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    filter = button.dataset.type;
    $('kitFilters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === button));
    render();
  };
  render();
}).catch(() => { $('kitGrid').innerHTML = '<div class="empty">The furniture list could not be loaded.</div>'; });
$('kitSearch').addEventListener('input', render);
