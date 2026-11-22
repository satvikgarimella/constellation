import { validateScene } from './scene.js';

export const MAX_BENCHMARK_WORKERS = 8;
export const BENCHMARK_TRIALS = 3;

const clone = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right) && same([...left].sort(), [...right].sort());
const esc = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const clock = value => value < 1 ? `${value.toFixed(3)}s` : value < 60 ? `${value.toFixed(2)}s` : `${Math.floor(value / 60)}m ${(value % 60).toFixed(1)}s`;

export function median(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Benchmark times must be positive finite numbers.');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Freeze a nested set of participants. Later joins cannot change the workload. */
export function planScalingBenchmark(clients, baselineId) {
  const ready = clients.filter(client => client.enabled && ['webgpu', 'cpu'].includes(client.backend));
  const baseline = ready.find(client => client.id === baselineId);
  if (!baseline) throw new Error('Choose a contributing solo device first.');
  const matching = [baseline, ...ready.filter(client => client.id !== baseline.id && client.backend === baseline.backend)];
  if (matching.length < 2) throw new Error('Connect at least two devices using the same renderer.');
  const workers = matching.slice(0, MAX_BENCHMARK_WORKERS).map(({id, label, backend}) => ({id, label, backend}));
  const counts = [...new Set([1, 2, ...(workers.length >= 4 ? [4] : []), workers.length])].sort((a, b) => a - b);
  const cohorts = counts.map(count => ({count, workerIds:workers.slice(0, count).map(worker => worker.id)}));
  const steps = cohorts.map(cohort => ({...cohort, warmup:true, trial:0}));
  // Rotate the first cohort each round so the solo run does not always go first.
  for (let round = 0; round < BENCHMARK_TRIALS; round++) {
    for (let offset = 0; offset < cohorts.length; offset++) {
      const cohort = cohorts[(round + offset) % cohorts.length];
      steps.push({...cohort, warmup:false, trial:round + 1});
    }
  }
  return {baselineId, backend:baseline.backend, workers, cohorts, steps, excludedMatching:Math.max(0, matching.length - workers.length)};
}

export function summarizeScalingRuns(runs, cohorts) {
  const summaries = cohorts.map(cohort => {
    const measured = runs.filter(run => !run.warmup && run.count === cohort.count);
    const times = measured.map(run => run.seconds);
    return {count:cohort.count, workerIds:[...cohort.workerIds], trials:measured.length,
      medianSeconds:times.length ? median(times) : null,
      minSeconds:times.length ? Math.min(...times) : null,
      maxSeconds:times.length ? Math.max(...times) : null,
      speedup:null, complete:measured.length === BENCHMARK_TRIALS};
  });
  const baseline = summaries.find(summary => summary.count === 1);
  if (baseline?.medianSeconds) for (const summary of summaries) {
    if (summary.medianSeconds) summary.speedup = baseline.medianSeconds / summary.medianSeconds;
  }
  return summaries;
}

export function createScalingBenchmark({send, onChange = () => {}, now = () => Date.now()} = {}) {
  if (typeof send !== 'function') throw new Error('A benchmark needs a send function.');
  let session = null;
  const active = () => session?.status === 'running';
  const snapshot = () => {
    if (!session) return {status:'idle', active:false, summaries:[], runs:[]};
    const {config, ...data} = session;
    return clone({...data, active:active(), sceneName:config.scene.name,
      settings:{width:config.width,height:config.width,samples:config.samples,bounces:config.bounces},
      summaries:summarizeScalingRuns(session.runs, session.plan.cohorts)});
  };
  const notify = () => onChange(snapshot());
  const cancel = (reason = 'Benchmark stopped. Completed trials are preserved.', {sendCancel = true} = {}) => {
    if (!active()) return;
    session.status = 'cancelled';session.reason = reason;session.finishedAt = now();
    notify();
    if (sendCancel) send({type:'cancel'});
  };
  const begin = () => {
    session.current = session.plan.steps[session.stepIndex];
    session.runId = null;session.waitingSince = now();
    notify();
    send({type:'start', ...clone(session.config), workerIds:[...session.current.workerIds]});
  };
  const start = ({state, baselineId, config}) => {
    if (active()) throw new Error('A scaling benchmark is already running.');
    if (!state || state.run?.status === 'running') throw new Error('Finish or stop the current render first.');
    const plan = planScalingBenchmark(state.clients, baselineId);
    const frozen = {scene:validateScene(config.scene),width:Number(config.width),samples:Number(config.samples),bounces:Number(config.bounces ?? 4)};
    if (![256,512,768,1024,2048].includes(frozen.width) || ![8,16,32,64,128,256,512].includes(frozen.samples) || ![2,3,4,5].includes(frozen.bounces)) throw new Error('Choose supported render quality settings.');
    session = {status:'running',reason:null,roomId:state.roomId,startedAt:now(),finishedAt:null,plan,config:frozen,
      fingerprint:null,previousRun:state.run?.id ?? 0,runId:null,stepIndex:0,current:null,runs:[],waitingSince:now()};
    try {begin();} catch {cancel('The benchmark could not start. Reconnect and try again.', {sendCancel:false});}
    return snapshot();
  };
  const update = state => {
    if (!active()) return;
    const s = session, step = s.current;
    try {
      if (state.roomId !== s.roomId) throw new Error('The room changed. Start a new benchmark.');
      if (s.plan.workers.some(worker => !state.clients.some(client => client.id === worker.id && client.enabled && client.backend === worker.backend))) {
        throw new Error('A selected device disconnected, paused, or changed renderer. Reconnect it and restart the benchmark.');
      }
      const run = state.run;
      if (!run || run.id <= s.previousRun) {
        if (now() - s.waitingSince > 15000) throw new Error('The next benchmark render did not start. Reconnect and try again.');
        return;
      }
      if (s.runId === null) {
        if (run.id !== s.previousRun + 1) throw new Error('Another render interrupted the benchmark.');
        s.runId = run.id;
      }
      if (run.id !== s.runId || run.status === 'cancelled') throw new Error('The benchmark render was stopped or replaced.');
      const settings = {width:s.config.width,height:s.config.width,samples:s.config.samples,bounces:s.config.bounces};
      if (!same(run.settings, settings) || !same(validateScene(state.scene), s.config.scene)) throw new Error('Scene or quality changed during the benchmark.');
      if (!sameIds(run.workerIds, step.workerIds) || !sameIds(run.initialWorkers?.map(worker => worker.id), step.workerIds)
        || run.initialWorkers.some(worker => worker.backend !== s.plan.backend)) throw new Error('The benchmark participant group changed.');
      if (!run.fingerprint || (s.fingerprint && run.fingerprint !== s.fingerprint)) throw new Error('The rendered workload changed during the benchmark.');
      s.fingerprint ??= run.fingerprint;
      if (run.retries > 0) throw new Error('A benchmark tile needed recovery. Reconnect the devices and repeat for a clean measurement.');
      if (run.status !== 'complete') return;
      const record = state.history.find(item => item.runId === run.id);
      if (!record || record.fingerprint !== s.fingerprint || !Number.isFinite(record.seconds) || record.seconds <= 0
        || record.width !== settings.width || record.samples !== settings.samples || record.backends !== s.plan.backend) {
        throw new Error('The completed render did not provide a matching measurement.');
      }
      if (!sameIds(record.contributors?.map(worker => worker.id), step.workerIds)
        || record.contributors.some(worker => worker.backend !== s.plan.backend || !same(worker.backends, [s.plan.backend]) || worker.tiles <= 0 || worker.pixels <= 0)) {
        throw new Error('Every selected device must finish work. Increase the workload and repeat.');
      }
      s.runs.push({runId:run.id,count:step.count,warmup:step.warmup,trial:step.trial,seconds:record.seconds,
        fingerprint:record.fingerprint,workerIds:[...step.workerIds],contributors:clone(record.contributors),retries:run.retries});
      s.previousRun = run.id;s.stepIndex++;
      if (s.stepIndex === s.plan.steps.length) {
        s.status = 'complete';s.finishedAt = now();s.current = null;notify();
      } else begin();
    } catch (error) {cancel(error.message || 'Benchmark interrupted.');}
  };
  const report = () => ({schemaVersion:1,kind:'constellation-scaling-benchmark',...snapshot(),
    method:{trialsPerCohort:BENCHMARK_TRIALS,warmupsPerCohort:1,summary:'Median of completed measured runs; warmups excluded.',
      order:'One warmup per cohort, then three rounds with the first cohort rotated each round.',
      timings:'Server elapsed time includes scheduling, network transfer, and browser rendering.',
      hardware:'Browser sessions are not proof of separate physical devices. Confirm the hardware used before claiming crowd speedup.',
      limits:`At most ${MAX_BENCHMARK_WORKERS} matching participants per benchmark. Later joins are excluded.`}});
  return {start,update,cancel,snapshot,report,get active(){return active();}};
}

export function scalingMarkup() {
  return `<section class="scaling-benchmark" aria-labelledby="scaling-heading">
    <div class="scaling-heading"><div><h3 id="scaling-heading">Measure your constellation</h3><p>One device, then 2, 4, and up to 8. Three measured runs per group.</p></div><span class="tag">REPEATED TEST</span></div>
    <p class="scaling-note">Uses the Solo device above and the current scene and quality. Keep every selected device open. Each group warms up once; timings include networking.</p>
    <div class="scaling-actions"><button id="scaling-start" class="button secondary">Run scaling benchmark</button><button id="scaling-stop" class="button danger hidden">Stop benchmark</button><button id="scaling-export" class="button secondary" disabled>Export results</button></div>
    <p id="scaling-status" class="scaling-status" role="status" aria-live="polite">Connect at least two matching contributors to measure scaling.</p>
    <div id="scaling-results"></div>
    <p class="scaling-note">Use separate physical devices. Several tabs on one computer share its hardware. More devices can be slower.</p>
  </section>`;
}

/** Renders only benchmark-owned content; the host decides whether Start is allowed. */
export function renderScalingPanel(element, state) {
  if (!element || !state) return;
  const status = element.querySelector('#scaling-status'), start = element.querySelector('#scaling-start'), stop = element.querySelector('#scaling-stop');
  start.classList.toggle('hidden', state.active);stop.classList.toggle('hidden', !state.active);
  element.querySelector('#scaling-export').disabled = !state.runs?.length;
  if (state.active) {
    const step = state.current;
    status.textContent = `${state.stepIndex + 1} / ${state.plan.steps.length} · ${step.warmup ? 'Warmup' : `Trial ${step.trial} of ${BENCHMARK_TRIALS}`} · ${step.count} device${step.count === 1 ? '' : 's'}${state.plan.excludedMatching ? ` · ${state.plan.excludedMatching} extra matching devices excluded` : ''}`;
  } else if (state.status === 'complete') status.textContent = 'Complete · three measured runs per group. Bars show medians; whiskers show the fastest and slowest runs.';
  else if (state.status === 'cancelled') status.textContent = `Stopped · ${state.reason} Any partial results below are incomplete.`;
  const results = element.querySelector('#scaling-results'), summaries = state.summaries ?? [];
  if (!summaries.some(summary => summary.trials)) {results.innerHTML = '';return;}
  const maxTime = Math.max(...summaries.map(summary => summary.maxSeconds ?? 0), 0.001), graphWidth = 500, left = 78, plotWidth = 318, rowHeight = 52, height = summaries.length * rowHeight + 35;
  const rows = summaries.map((summary, index) => {
    const y = 26 + index * rowHeight, medianWidth = (summary.medianSeconds ?? 0) / maxTime * plotWidth;
    const minX = left + (summary.minSeconds ?? 0) / maxTime * plotWidth, maxX = left + (summary.maxSeconds ?? 0) / maxTime * plotWidth;
    return `<text x="0" y="${y + 16}" class="scaling-axis">${summary.count} device${summary.count === 1 ? '' : 's'}</text>${summary.trials ? `<rect x="${left}" y="${y}" width="${Math.max(1, medianWidth)}" height="23" rx="3" class="scaling-bar${summary.count === 1 ? ' baseline' : ''}"/><path d="M${minX},${y + 11.5}H${maxX}M${minX},${y + 6}V${y + 17}M${maxX},${y + 6}V${y + 17}" class="scaling-range"/><text x="${left + plotWidth + 10}" y="${y + 16}" class="scaling-axis">${clock(summary.medianSeconds)}</text>` : `<text x="${left}" y="${y + 16}" class="scaling-axis">Waiting for measured runs</text>`}`;
  }).join('');
  const summaryText = summaries.filter(summary => summary.trials).map(summary => `${summary.count} devices: median ${clock(summary.medianSeconds)}, range ${clock(summary.minSeconds)} to ${clock(summary.maxSeconds)}, ${summary.trials} trials`).join('. ');
  results.innerHTML = `<p class="scaling-note">Results for <strong>${esc(state.sceneName)}</strong> · ${state.settings.width} × ${state.settings.height} · ${state.settings.samples} samples · ${state.settings.bounces} bounces</p><svg class="scaling-chart" viewBox="0 0 ${graphWidth} ${height}" role="img" aria-label="${esc(`Render time, lower is better. ${summaryText}`)}"><text x="${left}" y="12" class="scaling-axis">Elapsed time · lower is better</text>${rows}</svg>
    <div class="scaling-table-wrap"><table class="scaling-table"><caption>Measured render times; warmups excluded</caption><thead><tr><th scope="col">Devices</th><th scope="col">Trials</th><th scope="col">Median</th><th scope="col">Range</th><th scope="col">Speedup</th></tr></thead><tbody>${summaries.map(summary => `<tr><th scope="row">${summary.count}</th><td>${summary.trials} / ${BENCHMARK_TRIALS}</td><td>${summary.medianSeconds ? clock(summary.medianSeconds) : '—'}</td><td>${summary.trials ? `${clock(summary.minSeconds)} – ${clock(summary.maxSeconds)}` : '—'}</td><td>${summary.speedup ? `${summary.speedup.toFixed(2)}×${summary.speedup < 1 ? ' · slower' : ''}${summary.complete && summaries[0].complete ? '' : ' · partial'}` : '—'}</td></tr>`).join('')}</tbody></table></div>
    ${summaries.some(summary => summary.minSeconds !== null && summary.minSeconds < 1) ? '<p class="scaling-note">Some runs took less than a second. Try a larger workload for a more stable comparison.</p>' : ''}
    <details class="scaling-details"><summary>Individual runs and device contributions</summary>${(state.runs ?? []).map(run => `<div class="scaling-run"><strong>${run.warmup ? 'Warmup' : `Trial ${run.trial}`} · ${run.count} device${run.count === 1 ? '' : 's'} · ${clock(run.seconds)}</strong><span>${run.contributors.map(worker => `${esc(worker.label)}: ${worker.tiles} tiles`).join(' · ')}</span></div>`).join('')}</details>`;
}
