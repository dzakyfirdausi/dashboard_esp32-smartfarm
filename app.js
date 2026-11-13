// =====================================================================
// 1. STATE GLOBAL
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
      const kelembapan = clamp(Number(data.kelembapan) || 0, 0, 100);
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
      }
      updateGauge(kelembapan, warna);

      // B. Kondisi tanah berdasarkan ambang hysteresis aktif
      const boxTanah = document.getElementById('boxTanah');
      boxTanah.className = 'status-box';
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
      boxTanah.classList.add(kondisi);

      setText('infoBatas', `Batas: <${batasMin}% Kering | \u2265${batasMax}% Lembap`);
      setText('infoMin', `< ${batasMin}%`);
      setText('infoMax', `\u2265 ${batasMax}%`);

      // C. Status pompa & mode
      const boxPompa = document.getElementById('boxPompa');
      boxPompa.className = 'status-box';
      if (isPumpOn) {
        setText('statusPompa', 'ON / MENYIRAM');
        boxPompa.classList.add('pompa-on');
      } else {
        setText('statusPompa', 'OFF / STANDBY');
      }
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
        const free = clamp(Number(data.memoriFree) || 0, 0, 100);
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
const PX_PER_LABEL = 30;

/** Lebarkan area grafik bila label banyak (area bisa digeser horizontal) */
function aturLebarGrafik(jumlahLabel) {
  const container = document.querySelector('.chart-container');
  const inner = document.getElementById('chartInner');
  if (!container || !inner) return;
  const butuh = Math.min(jumlahLabel * PX_PER_LABEL + 60, 8000);
  inner.style.width = butuh > container.clientWidth ? butuh + 'px' : '100%';
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

  // Sumbu X dimulai dari 0 dan berakhir di kelipatan 5 berikutnya (minimal s/d 60 menit)
  let xMin = 0, xMax = 60;
  if (points.length) {
    xMin = Math.min(0, Math.floor(Math.min(...points.map(p => p.x)) / STEP_DASAR) * STEP_DASAR);
    xMax = Math.max(60, Math.ceil(Math.max(...points.map(p => p.x)) / STEP_DASAR) * STEP_DASAR);
    if (xMax <= xMin) xMax = xMin + STEP_DASAR;
  }
  aturLebarGrafik((xMax - xMin) / STEP_DASAR + 1);

  const jumlahTerbaru = 12; // 12 x 5 menit = 1 jam terakhir disorot hijau
  const barColors = points.map((p, i) => {
    if (p.y < batasMin) return '#f2b8b5';
    return i >= points.length - jumlahTerbaru ? '#2e9e5e' : '#cfe5d8';
  });

  const garisBatas = (nilai) => [{ x: xMin, y: nilai }, { x: xMax, y: nilai }];

  const datasets = [
    {
      type: 'line',
      label: 'Rata-rata bergerak',
      data: movingAverage(points, 5),
      borderColor: '#1f7a47',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.4,
      order: 0
    },
    {
      type: 'line',
      label: `Batas lembap (${batasMax}%)`,
      data: garisBatas(batasMax),
      borderColor: '#f59e0b',
      borderDash: [6, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      order: 1
    },
    {
      type: 'line',
      label: `Batas kering (${batasMin}%)`,
      data: garisBatas(batasMin),
      borderColor: '#ef4444',
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
      hoverBackgroundColor: '#1f7a47',
      borderRadius: 3,
      barPercentage: 0.7,
      categoryPercentage: 1,
      order: 2
    }
  ];

  if (chartInstance) {
    chartInstance.data.datasets = datasets;
    chartInstance.options.scales.x.min = xMin;
    chartInstance.options.scales.x.max = xMax;
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
      animation: { duration: 500 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          offset: false,
          grid: { display: false },
          border: { color: '#e8ecea' },
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
            color: '#7b8580',
            font: { size: 11 },
            callback: (value) => String(Math.round(value))
          },
          title: { display: true, text: 'Waktu Pencatatan (menit)', color: '#7b8580', font: { size: 11 } }
        },
        y: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, color: '#7b8580', font: { size: 11 }, callback: (v) => v + '%' },
          grid: { color: '#f0f2f1' },
          border: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1d2420',
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
  arc.style.opacity = nilai > 0 ? '0.9' : '0';
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

  btnAuto.classList.toggle('active', isAuto);
  btnManual.classList.toggle('active', !isAuto);
  btnAuto.innerHTML = isAuto ? '&#10003; Otomatis' : 'Otomatis';
  btnManual.innerHTML = !isAuto ? '&#10003; Manual' : 'Manual';

  if (isAuto) {
    btnPompa.disabled = true;
    btnPompa.classList.remove('pump-active');
    btnPompa.innerHTML = '&#128274; Pompa Terkunci (Mode Otomatis)';
  } else {
    btnPompa.disabled = false;
    btnPompa.classList.toggle('pump-active', isPumpOn);
    btnPompa.textContent = isPumpOn ? 'Matikan Pompa Sekarang' : 'Nyalakan Pompa Sekarang';
  }
}

function updateInsight(kelembapan, kondisi) {
  let insight, ringkasan;
  if (kondisi === 'kering') {
    ringkasan = 'Tanah sedang kering dan perlu perhatian.';
    insight = isAuto
      ? `Kelembapan ${kelembapan}% berada di bawah batas ${batasMin}%. Pompa otomatis akan menyiram hingga mencapai ${batasMax}%.`
      : `Kelembapan ${kelembapan}% di bawah batas ${batasMin}%. Mode manual aktif — nyalakan pompa untuk menyiram.`;
  } else if (kondisi === 'lembap') {
    ringkasan = 'Kondisi kebun lembap dan aman.';
    insight = `Kelembapan ${kelembapan}% sudah melewati batas ${batasMax}%. Penyiraman tidak diperlukan saat ini.`;
  } else {
    ringkasan = 'Kondisi kebun stabil.';
    insight = `Kelembapan ${kelembapan}% berada di rentang ideal (${batasMin}%–${batasMax}%). Tanaman mendapat cukup air untuk tumbuh sehat.`;
  }
  if (isPumpOn) insight += ' Pompa sedang menyiram.';
  setText('teksInsight', insight);
  setText('teksRingkasan', `${ringkasan} Berikut ringkasan sistem penyiraman hari ini.`);
}

function warnaKelembapan(k) {
  if (k < batasMin) return '#dc2626';
  if (k >= batasMax) return '#2e9e5e';
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
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg> Unduh Log Data (.CSV)';
  } else {
    btn.classList.add('is-disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
    btn.removeAttribute('download');
    btn.innerHTML = '&#128274; Belum Ada Data (.CSV)';
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
  if (el) el.textContent = value;
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
});
