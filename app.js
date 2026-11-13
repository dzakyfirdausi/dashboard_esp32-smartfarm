// =====================================================================
// 1. STATE GLOBAL & IKON SVG
// =====================================================================
let isAuto = true;
let isPumpOn = false;
let batasMin = 30;
let batasMax = 50;
let chartInstance = null;
let historyPoints = [];   // [{x: menit, y: kelembapan}]
let isFetchingLive = false;
let isFetchingCsv = false;

const STEP_DASAR = 5;     // Sumbu waktu grafik selalu kelipatan 5 menit (0, 5, 10, 15, ...)
const JUMLAH_BAR_MEMORI = 26;

const ICONS = {
  check: '<svg viewBox="0 0 24 24" class="seg-icon" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  auto: '<svg viewBox="0 0 24 24" class="seg-icon" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" class="seg-icon" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'
};

// =====================================================================
// 2. KOMUNIKASI API
// =====================================================================

/**
 * Mengambil status terkini dari RAM ESP32 setiap 2 detik
 * Endpoint: GET /api/live
 * Format JSON: {"kelembapan": 45, "pompa": false, "auto": true, "min": 30, "max": 50, "memoriFree": 88}
 */
function fetchLiveStatus(force = false) {
  if (!force && (isFetchingLive || isFetchingCsv)) return;
  isFetchingLive = true;
  fetch('/api/live')
    .then(response => {
      if (!response.ok) throw new Error('Respon jaringan bermasalah');
      return response.json();
    })
    .then(data => {
      setConnectionStatus(true);

      isAuto = Boolean(data.auto);
      isPumpOn = Boolean(data.pompa);
      const kelembapan = clamp(Math.round(Number(data.kelembapan) || 0), 0, 100);
      const minBaru = Number(data.min) || 30;
      const maxBaru = Number(data.max) || 50;
      const batasBerubah = minBaru !== batasMin || maxBaru !== batasMax;
      batasMin = minBaru;
      batasMax = maxBaru;

      // A. Angka, progress bar, & gauge kelembapan
      setText('valKelembapan', kelembapan);
      setText('valKelembapanMini', kelembapan);
      const warna = warnaKelembapan(kelembapan);
      const barEl = document.getElementById('barKelembapan');
      if (barEl) {
        barEl.style.width = kelembapan + '%';
        barEl.style.backgroundColor = warna;
        const track = barEl.parentElement;
        if (track) track.setAttribute('aria-valuenow', String(kelembapan));
      }
      updateGauge(kelembapan, warna);

      // B. Kondisi tanah berdasarkan ambang hysteresis aktif
      const boxTanah = document.getElementById('boxTanah');
      let kondisi;
      if (kelembapan < batasMin) {
        kondisi = 'kering';
        setText('statusTanah', 'TANAH KERING');
      } else if (kelembapan >= batasMax) {
        kondisi = 'lembap';
        setText('statusTanah', 'TANAH LEMBAP');
      } else {
        kondisi = 'normal';
        setText('statusTanah', 'IDEAL / NORMAL');
      }
      if (boxTanah) {
        boxTanah.className = 'status-box ' + kondisi;
      }

      setText('infoBatas', `Batas: <${batasMin}% Kering · \u2265${batasMax}% Lembap`);
      setText('infoMin', `< ${batasMin}%`);
      setText('infoMax', `\u2265 ${batasMax}%`);

      // C. Status pompa & mode
      const boxPompa = document.getElementById('boxPompa');
      if (boxPompa) {
        boxPompa.className = 'status-box' + (isPumpOn ? ' pompa-on' : '');
      }
      setText('statusPompa', isPumpOn ? 'ON / MENYIRAM' : 'OFF / STANDBY');
      setText('statusMode', isAuto ? 'Otomatis' : 'Manual');
      const spray = document.getElementById('semprotanAir');
      if (spray) spray.classList.toggle('on', isPumpOn);

      // D. Sinkronisasi tombol mode & sakelar manual
      syncControlButtons();

      // E. Sinkronisasi dropdown preset
      const presetSelect = document.getElementById('presetTanaman');
      const currentPair = `${batasMin},${batasMax}`;
      if (presetSelect && document.activeElement !== presetSelect) {
        for (let i = 0; i < presetSelect.options.length; i++) {
          if (presetSelect.options[i].value === currentPair) {
            presetSelect.selectedIndex = i;
            break;
          }
        }
      }

      // F. Sisa memori flash (LittleFS)
      if (data.memoriFree !== undefined) {
        const free = clamp(Math.round(Number(data.memoriFree) || 0), 0, 100);
        setText('sisaMemori', `${free}%`);
        updateMemoryBars(free);
      }

      // G. Teks ringkasan & insight
      updateInsight(kelembapan, kondisi);

      // Garis batas di grafik ikut berubah saat preset diganti
      if (batasBerubah && chartInstance) drawChart(historyPoints);
    })
    .catch(err => {
      console.warn('Gagal mengambil data /api/live:', err);
      setConnectionStatus(false);
    })
    .finally(() => {
      isFetchingLive = false;
    });
}

/**
 * Perpindahan Mode Otomatis (1) / Manual (0)
 * Endpoint: GET /api/control?auto=1 atau ?auto=0
 */
function toggleOperationMode(modeValue) {
  const targetMode = modeValue ? 1 : 0;
  fetch(`/api/control?auto=${targetMode}`)
    .then(res => { if (res.ok) fetchLiveStatus(true); })
    .catch(err => console.error('Gagal mengubah mode:', err));
}

/**
 * Menyalakan/mematikan pompa saat Mode Manual aktif
 * Endpoint: GET /api/control?pump=1 atau ?pump=0
 */
function toggleManualPump(pumpState) {
  if (isAuto) return;
  const targetPump = (pumpState !== undefined) ? pumpState : (isPumpOn ? 0 : 1);
  fetch(`/api/control?pump=${targetPump}`)
    .then(res => { if (res.ok) fetchLiveStatus(true); })
    .catch(err => console.error('Gagal mengontrol pompa manual:', err));
}

/**
 * Mengirim ambang batas baru (min & max) ke ESP32
 * Endpoint: GET /api/preset?min=30&max=50
 */
function updateCropPreset(minVal, maxVal) {
  let min = minVal;
  let max = maxVal;
  if (min === undefined || max === undefined) {
    const parts = document.getElementById('presetTanaman').value.split(',');
    min = parseInt(parts[0], 10);
    max = parseInt(parts[1], 10);
  }
  fetch(`/api/preset?min=${min}&max=${max}`)
    .then(res => { if (res.ok) fetchLiveStatus(true); })
    .catch(err => console.error('Gagal memperbarui preset tanaman:', err));
}

/**
 * Mengambil CSV dari LittleFS lalu merender grafik
 * Endpoint: GET /download-csv  (header: Waktu_Menit,Kelembapan)
 */
function renderHistoryChart() {
  if (isFetchingCsv) return;
  isFetchingCsv = true; // Tunda polling /api/live selama ESP32 mengirim berkas CSV
  fetch('/download-csv')
    .then(response => {
      if (!response.ok) throw new Error('Gagal memuat berkas CSV');
      return response.text();
    })
    .then(csvText => {
      const lines = csvText.trim().split(/\r?\n/);
      const points = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',');
        if (cols.length < 2) continue;
        const y = parseFloat(cols[1]);
        if (isNaN(y)) continue;
        let x = parseWaktu(cols[0]);
        if (x === null) x = points.length * STEP_DASAR; // fallback: urutan log tiap 5 menit
        points.push({ x, y });
      }
      historyPoints = points;
      setCsvDownloadState(points.length > 0);
      updateHistoryStats(points);
      drawChart(points);
    })
    .catch(err => {
      console.warn('Data CSV belum tersedia, menampilkan grafik kosong:', err);
      historyPoints = [];
      setCsvDownloadState(false);
      updateHistoryStats([]);
      drawChart([]);
    })
    .finally(() => {
      isFetchingCsv = false;
    });
}

// =====================================================================
// 3. GRAFIK (Chart.js) — sumbu waktu kelipatan 5 (0, 5, 10, 15, ...)
// =====================================================================

/** Ubah kolom waktu ("15", "15.0", atau "01:15") menjadi menit */
function parseWaktu(raw) {
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

/** Lebar minimum per label waktu (px) agar 0, 5, 10, ... tidak berdesakan */
const PX_PER_LABEL = 32;
let jumlahLabelTerakhir = 13;

/** Lebarkan area grafik bila label banyak (area bisa digeser horizontal) */
function aturLebarGrafik(jumlahLabel) {
  if (typeof jumlahLabel === 'number' && jumlahLabel > 0) {
    jumlahLabelTerakhir = jumlahLabel;
  }
  const container = document.querySelector('.chart-container');
  const inner = document.getElementById('chartInner');
  if (!container || !inner) return;
  inner.style.width = '100%';
  const lebarContainer = container.clientWidth || 0;
  const butuh = Math.min(jumlahLabelTerakhir * PX_PER_LABEL + 60, 8000);
  inner.style.width = butuh > lebarContainer ? butuh + 'px' : '100%';
}

function movingAverage(points, window) {
  return points.map((p, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = points.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b.y, 0) / slice.length;
    return { x: p.x, y: Math.round(avg * 10) / 10 };
  });
}

function drawChart(points) {
  const canvas = document.getElementById('grafikKelembapan');
  if (!canvas || typeof Chart === 'undefined') return;

  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sumbu X dimulai dari 0 dan berakhir di kelipatan 5 berikutnya (minimal s/d 60 menit)
  let xMin = 0, xMax = 60;
  if (points.length) {
    xMin = Math.min(0, Math.floor(Math.min(...points.map(p => p.x)) / STEP_DASAR) * STEP_DASAR);
    xMax = Math.max(60, Math.ceil(Math.max(...points.map(p => p.x)) / STEP_DASAR) * STEP_DASAR);
    if (xMax <= xMin) xMax = xMin + STEP_DASAR;
  }
  aturLebarGrafik((xMax - xMin) / STEP_DASAR + 1);

  const jumlahTerbaru = 12; // 12 x 5 menit = 1 jam terakhir disorot hijau utama
  const barColors = points.map((p, i) => {
    if (p.y < batasMin) return '#f87171';
    return i >= points.length - jumlahTerbaru ? '#15803d' : '#b7dec6';
  });

  const garisBatas = (nilai) => [{ x: xMin, y: nilai }, { x: xMax, y: nilai }];

  const datasets = [
    {
      type: 'line',
      label: 'Rata-rata bergerak',
      data: movingAverage(points, 5),
      borderColor: '#0f5328',
      borderWidth: 2.2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.4,
      order: 0
    },
    {
      type: 'line',
      label: `Batas lembap (${batasMax}%)`,
      data: garisBatas(batasMax),
      borderColor: '#d97706',
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      order: 1
    },
    {
      type: 'line',
      label: `Batas kering (${batasMin}%)`,
      data: garisBatas(batasMin),
      borderColor: '#dc2626',
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      order: 1
    },
    {
      type: 'bar',
      label: 'Kelembapan Tanah (%)',
      data: points,
      backgroundColor: barColors,
      hoverBackgroundColor: '#115e2d',
      borderRadius: 4,
      barPercentage: 0.68,
      categoryPercentage: 0.96,
      order: 2
    }
  ];

  if (chartInstance) {
    chartInstance.data.datasets = datasets;
    chartInstance.options.scales.x.min = xMin;
    chartInstance.options.scales.x.max = xMax;
    chartInstance.options.animation.duration = prefersReducedMotion ? 0 : 400;
    chartInstance.resize();
    chartInstance.update();
    geserKeDataTerbaru();
    return;
  }

  chartInstance = new Chart(canvas, {
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: prefersReducedMotion ? 0 : 450 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          offset: false,
          grid: { display: false },
          border: { color: '#d8e3dc' },
          // Tick selalu tiap 5 menit: 0, 5, 10, 15, 20, ...
          afterBuildTicks: (axis) => {
            const start = Math.ceil(axis.min / STEP_DASAR) * STEP_DASAR;
            const ticks = [];
            for (let v = start; v <= axis.max + 1e-9; v += STEP_DASAR) ticks.push({ value: v });
            axis.ticks = ticks;
          },
          ticks: {
            autoSkip: false,
            maxRotation: 0,
            color: '#43564b',
            font: { size: 11, weight: '500' },
            callback: (value) => String(Math.round(value))
          },
          title: {
            display: true,
            text: 'Waktu Pencatatan (menit)',
            color: '#43564b',
            font: { size: 11, weight: '600' }
          }
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 25,
            color: '#43564b',
            font: { size: 11, weight: '500' },
            callback: (v) => v + '%'
          },
          grid: { color: '#ebf1ed' },
          border: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#112218',
          titleColor: '#ffffff',
          bodyColor: '#e2eee7',
          padding: 10,
          cornerRadius: 10,
          filter: (item) => item.datasetIndex === 0 || item.datasetIndex === 3,
          callbacks: {
            title: (items) => items.length ? `Menit ke-${Math.round(items[0].parsed.x)}` : '',
            label: (item) => ` ${item.dataset.label}: ${item.parsed.y}%`
          }
        }
      }
    }
  });
  geserKeDataTerbaru();
}

/** Bila grafik lebih lebar dari layar, otomatis geser ke data paling baru (kanan) */
function geserKeDataTerbaru() {
  const container = document.querySelector('.chart-container');
  if (container) container.scrollLeft = container.scrollWidth;
}

function updateHistoryStats(points) {
  if (!points.length) {
    ['chartLast', 'chartMax', 'chartMin', 'chartAvg'].forEach(id => setText(id, '--'));
    ['statMax', 'statMin', 'statAvg'].forEach(id => setText(id, '--'));
    return;
  }
  const ys = points.map(p => p.y);
  const max = Math.max(...ys);
  const min = Math.min(...ys);
  const avg = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
  setText('chartLast', ys[ys.length - 1]);
  setText('chartMax', max);
  setText('chartMin', min);
  setText('chartAvg', avg);
  setText('statMax', max + '%');
  setText('statMin', min + '%');
  setText('statAvg', avg + '%');
}

// =====================================================================
// 4. HELPER TAMPILAN
// =====================================================================

function updateGauge(nilai, warna) {
  const arc = document.getElementById('gaugeArc');
  const knob = document.getElementById('gaugeKnob');
  if (!arc || !knob) return;
  arc.setAttribute('stroke-dasharray', `${nilai} 999`);
  arc.style.opacity = nilai > 0 ? '0.95' : '0';
  arc.style.stroke = warna;
  const sudut = Math.PI * (1 - nilai / 100);
  knob.setAttribute('cx', (120 + 90 * Math.cos(sudut)).toFixed(1));
  knob.setAttribute('cy', (124 - 90 * Math.sin(sudut)).toFixed(1));
  knob.style.stroke = warna;
}

function buildMemoryBars() {
  const wrap = document.getElementById('barMemori');
  if (!wrap || wrap.children.length) return;
  for (let i = 0; i < JUMLAH_BAR_MEMORI; i++) {
    const bar = document.createElement('i');
    // Pola tinggi bervariasi agar mirip visual "charge level"
    const h = 45 + Math.round(Math.abs(Math.sin(i * 1.7)) * 55);
    bar.style.height = h + '%';
    wrap.appendChild(bar);
  }
}

function updateMemoryBars(freePercent) {
  buildMemoryBars();
  const bars = document.querySelectorAll('#barMemori i');
  const aktif = Math.round(freePercent / 100 * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < aktif));
}

function syncControlButtons() {
  const btnAuto = document.getElementById('btnAuto');
  const btnManual = document.getElementById('btnManual');
  const btnPompa = document.getElementById('btnPompaManual');
  if (!btnAuto || !btnManual || !btnPompa) return;

  btnAuto.classList.toggle('active', isAuto);
  btnManual.classList.toggle('active', !isAuto);
  btnAuto.setAttribute('aria-pressed', String(isAuto));
  btnManual.setAttribute('aria-pressed', String(!isAuto));

  const htmlAuto = `${isAuto ? ICONS.check : ICONS.auto}<span>Otomatis</span>`;
  const htmlManual = `${!isAuto ? ICONS.check : ICONS.sliders}<span>Manual</span>`;
  if (btnAuto.innerHTML !== htmlAuto) btnAuto.innerHTML = htmlAuto;
  if (btnManual.innerHTML !== htmlManual) btnManual.innerHTML = htmlManual;

  if (isAuto) {
    btnPompa.disabled = true;
    btnPompa.classList.remove('pump-active');
    const htmlLocked = `${ICONS.lock}<span>Pompa Terkunci (Mode Otomatis)</span>`;
    if (btnPompa.innerHTML !== htmlLocked) btnPompa.innerHTML = htmlLocked;
  } else {
    btnPompa.disabled = false;
    btnPompa.classList.toggle('pump-active', isPumpOn);
    const label = isPumpOn ? 'Matikan Pompa Sekarang' : 'Nyalakan Pompa Sekarang';
    const htmlActive = `${ICONS.power}<span>${label}</span>`;
    if (btnPompa.innerHTML !== htmlActive) btnPompa.innerHTML = htmlActive;
  }
}

function updateInsight(kelembapan, kondisi) {
  let insight, ringkasan;
  if (kondisi === 'kering') {
    ringkasan = 'Tanah sedang kering dan memerlukan penyiraman.';
    insight = isAuto
      ? `Kelembapan ${kelembapan}% berada di bawah batas ${batasMin}%. Pompa otomatis menyiram hingga mencapai ${batasMax}%.`
      : `Kelembapan ${kelembapan}% di bawah batas ${batasMin}%. Mode manual aktif — nyalakan pompa untuk menyiram.`;
  } else if (kondisi === 'lembap') {
    ringkasan = 'Kondisi kebun lembap dan cadangan air tanah mencukupi.';
    insight = `Kelembapan ${kelembapan}% sudah mencapai target ${batasMax}%. Penyiraman dihentikan sementara untuk mencegah genangan.`;
  } else {
    ringkasan = 'Kondisi kebun stabil dan ideal.';
    insight = `Kelembapan ${kelembapan}% berada di rentang ideal (${batasMin}%–${batasMax}%). Akar tanaman mendapat suplai air yang seimbang.`;
  }
  if (isPumpOn) insight += ' Pompa saat ini sedang menyiram.';
  setText('teksInsight', insight);
  setText('teksRingkasan', `${ringkasan} Berikut ringkasan sistem penyiraman hari ini.`);
}

function warnaKelembapan(k) {
  if (k < batasMin) return '#dc2626';
  if (k >= batasMax) return '#15803d';
  return '#0284c7';
}

function setConnectionStatus(isConnected) {
  const badge = document.getElementById('statusKoneksi');
  const text = document.getElementById('teksKoneksi');
  if (!badge || !text) return;
  badge.className = 'pill connection-badge ' + (isConnected ? 'connected' : 'disconnected');
  text.textContent = isConnected ? 'TERHUBUNG' : 'TERPUTUS';
}

function setCsvDownloadState(tersedia) {
  const btn = document.getElementById('btnUnduhCsv');
  if (!btn) return;
  if (tersedia) {
    btn.classList.remove('is-disabled');
    btn.setAttribute('aria-disabled', 'false');
    btn.setAttribute('href', '/download-csv');
    btn.setAttribute('download', 'data_log.csv');
    btn.innerHTML = `${ICONS.download}<span>Unduh Log Data (.CSV)</span>`;
  } else {
    btn.classList.add('is-disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
    btn.removeAttribute('download');
    btn.innerHTML = `${ICONS.lock}<span>Belum Ada Data (.CSV)</span>`;
  }
}

function updateClock() {
  const now = new Date();
  const hari = now.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
  const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  setText('jamSekarang', `${hari} · ${jam}`);
}

function setText(id, value) {
  const el = document.getElementById(id);
  const str = String(value);
  if (el && el.textContent !== str) el.textContent = str;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// =====================================================================
// 5. INISIALISASI & POLLING
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
  buildMemoryBars();
  updateClock();
  fetchLiveStatus();
  setTimeout(renderHistoryChart, 400); // Jeda 400 ms agar tidak membebani RAM ESP32 bersamaan dengan /api/live

  setInterval(fetchLiveStatus, 2000);        // real-time tiap 2 detik
  setInterval(renderHistoryChart, 300000);   // grafik tiap 5 menit
  setInterval(updateClock, 15000);

  // Cegah klik pada tombol unduh CSV jika berkas belum tersedia
  const btnUnduh = document.getElementById('btnUnduhCsv');
  if (btnUnduh) {
    btnUnduh.addEventListener('click', (e) => {
      if (btnUnduh.classList.contains('is-disabled')) e.preventDefault();
    });
  }

  // Sesuaikan ulang lebar kontainer grafik saat orientasi layar / ukuran viewport berubah
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      aturLebarGrafik(jumlahLabelTerakhir);
      if (chartInstance) chartInstance.resize();
    }, 150);
  });
});
