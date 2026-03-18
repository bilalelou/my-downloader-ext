const SERVER_URL = 'http://127.0.0.1:9876';

// DOM Elements
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const serverAlert = document.getElementById('serverAlert');
const statActive = document.getElementById('statActive');
const statPending = document.getElementById('statPending');
const statDone = document.getElementById('statDone');

// Keep track of the last interval handle
let intervalId = null;

async function fetchDownloads() {
  try {
    const res = await fetch(`${SERVER_URL}/downloads`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(3000)
    });
    
    if (!res.ok) throw new Error('Server returned ' + res.status);
    
    serverAlert.style.display = 'none';
    const data = await res.json();
    renderDownloads(data.downloads || []);
  } catch (error) {
    serverAlert.style.display = 'block';
  }
}

function renderDownloads(downloads) {
  if (downloads.length === 0) {
    emptyState.style.display = 'block';
    grid.innerHTML = '';
    
    statActive.textContent = `Active: 0`;
    statPending.textContent = `Pending: 0`;
    statDone.textContent = `Completed: 0`;
    return;
  }

  emptyState.style.display = 'none';
  grid.innerHTML = '';

  let activeCount = 0;
  let pendingCount = 0;
  let doneCount = 0;

  downloads.forEach(d => {
    // Stats tracking
    if (d.status === 'downloading' || d.status === 'retrying') activeCount++;
    else if (d.status === 'pending') pendingCount++;
    else if (d.status === 'completed') doneCount++;

    const card = document.createElement('div');
    card.className = 'download-card';

    // Parse Progress String
    // Example: "[download]  24.5% of ~1.23GiB at  4.56MiB/s ETA 00:27"
    let progressTxt = d.progress || 'Starting...';
    if (d.status === 'completed') progressTxt = '100% Downloaded';
    else if (d.status === 'pending') progressTxt = 'Waiting in Queue...';
    else if (d.status === 'cancelled') progressTxt = 'Cancelled by user';
    else if (d.status === 'retrying') progressTxt = 'Network error... Waiting to retry';

    const cleanProgress = progressTxt.replace('[download]', '').trim();

    // Determine status badge class
    let badgeClass = 's-pending';
    if (d.status === 'downloading') badgeClass = 's-downloading';
    else if (d.status === 'completed') badgeClass = 's-completed';
    else if (d.status === 'error') badgeClass = 's-error';
    else if (d.status === 'cancelled') badgeClass = 's-cancelled';
    else if (d.status === 'retrying') badgeClass = 's-retrying';

    // Tags
    let tagHTML = '';
    if (d.quality) {
      if (d.quality === 'audio') tagHTML += `<span class="tag tag-quality">AUDIO</span>`;
      else tagHTML += `<span class="tag tag-quality">${d.quality.toUpperCase()}</span>`;
    }
    if (d.is_playlist) {
      tagHTML += `<span class="tag tag-playlist">PLAYLIST</span>`;
    }

    card.innerHTML = `
      <div class="info-section">
        <div class="title-row">
          <div class="dp-title" title="${d.title}">${d.title}</div>
          ${tagHTML}
        </div>
        <div class="meta-row">
          <span>Added: ${d.date}</span>
        </div>
        <div class="progress-text">${cleanProgress}</div>
        ${d.error ? `<div class="err-text">Error: ${d.error}</div>` : ''}
      </div>
      
      <div class="status-badge ${badgeClass}">${d.status}</div>
    `;

    // Only show cancel button if pending or downloading
    if (d.status === 'downloading' || d.status === 'pending' || d.status === 'retrying') {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.textContent = 'Cancel';
      btn.onclick = () => cancelDownload(d.id);
      card.appendChild(btn);
    }

    // Show restart button if error, cancelled or interrupted
    if (d.status === 'error' || d.status === 'cancelled' || d.status === 'interrupted') {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.style.borderColor = 'rgba(34, 197, 94, 0.4)';
      btn.style.color = '#86efac';
      btn.style.background = 'rgba(34, 197, 94, 0.1)';
      btn.textContent = 'Restart';
      btn.onclick = () => restartDownload(d.id);
      card.appendChild(btn);
    }

    grid.appendChild(card);
  });

  // Update Stats
  statActive.textContent = `Active: ${activeCount}`;
  statPending.textContent = `Pending: ${pendingCount}`;
  statDone.textContent = `Completed: ${doneCount}`;
}

async function cancelDownload(id) {
  try {
    const res = await fetch(`${SERVER_URL}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Failed to cancel');
    }
    // Immediately fetch to reflect change
    fetchDownloads();
  } catch (error) {
    alert('Error connecting to server to cancel download.');
  }
}

async function restartDownload(id) {
  try {
    const res = await fetch(`${SERVER_URL}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Failed to restart');
    }
    fetchDownloads();
  } catch (error) {
    alert('Error connecting to server to restart download.');
  }
}

// Start polling every second
function startPolling() {
  fetchDownloads();
  intervalId = setInterval(fetchDownloads, 1000);
}

// Run
startPolling();
