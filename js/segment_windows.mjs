// Shared, frame-based timeline geometry; also exercised without a browser.
export const FPS = 24;
export const MAX_LENGTH = 3592;

export function alignedLength(frames, minimum = 5) {
  const lower = 5 + 17 * Math.max(0, Math.ceil((minimum - 5) / 17));
  return Math.min(
    MAX_LENGTH,
    Math.max(
      lower,
      5 + 17 * Math.max(0, Math.round((frames - 5) / 17))
    )
  );
}

export function nearestOverlap(frames, maximum) {
  const choices = [
    0,
    1,
    ...Array.from(
      { length: Math.max(0, Math.floor((maximum - 5) / 17) + 1) },
      (_, i) => 5 + 17 * i
    )
  ].filter(n => n <= maximum);

  return choices.reduce(
    (best, n) =>
      Math.abs(n - frames) < Math.abs(best - frames) ? n : best,
    0
  );
}

export function createWindows(previous, count, defaultFrames) {
  const result = [];

  for (let i = 0; i < count; i++) {
    const old = previous[i] || {};
    const prev = result[i - 1];

    const oldLength = Number.isInteger(old.endFrame)
      ? old.endFrame - old.startFrame
      : defaultFrames;

    const overlap = prev
      ? nearestOverlap(
          Number.isInteger(old.startFrame)
            ? prev.endFrame - old.startFrame
            : 39,
          Math.min(oldLength, prev.endFrame - prev.startFrame) - 1
        )
      : 0;

    // Preserve the user's requested newly contributed duration.
    const requested = Number.isInteger(old.requestedDurationFrames)
      ? old.requestedDurationFrames
      : Math.max(1, oldLength - overlap);

    // Add incoming overlap back before aligning to a legal H3 window.
    const length = alignedLengthAtLeast(
      requested + overlap,
      Math.max(5, overlap + 1)
    );

    const start = prev ? prev.endFrame - overlap : 0;

    result.push({
      ...old,
      images: [...(old.images || [])],
      audios: [...(old.audios || [])],
      prompt: old.prompt || "",
      startFrame: start,
      endFrame: start + length,
      requestedDurationFrames: requested
    });
  }

  return result;
}

export function editWindow(windows, index, mode, frame) {
  const result = windows.map(s => ({ ...s }));
  const s = result[index];
  const prev = result[index - 1];
  const next = result[index + 1];

  if (!s) return result;

  const oldEnd = s.endFrame;
  const oldLength = s.endFrame - s.startFrame;
  const outgoing = next ? s.endFrame - next.startFrame : 0;

  if (mode === "move" || mode === "left") {
    const incoming = prev
      ? nearestOverlap(
          prev.endFrame - Math.round(frame),
          Math.min(prev.endFrame - prev.startFrame, oldLength) - 1
        )
      : 0;

    s.startFrame = prev ? prev.endFrame - incoming : 0;

    const length = mode === "move"
      ? oldLength
      : alignedLength(
          oldEnd - s.startFrame,
          Math.max(incoming, outgoing) + 1
        );

    s.endFrame = s.startFrame + length;
  } else {
    const incoming = prev ? prev.endFrame - s.startFrame : 0;

    s.endFrame = s.startFrame + alignedLength(
      Math.round(frame) - s.startFrame,
      Math.max(incoming, outgoing) + 1
    );
  }

  // Manual geometry edits become the new requested contributed duration.
  const incoming = prev ? prev.endFrame - s.startFrame : 0;

  s.requestedDurationFrames =
    s.endFrame - s.startFrame - incoming;

  // Ripple subsequent windows to preserve their lengths and existing seam overlaps.
  const delta = s.endFrame - oldEnd;

  for (let i = index + 1; i < result.length; i++) {
    result[i].startFrame += delta;
    result[i].endFrame += delta;
  }

  return result;
}

// Convert a requested newly contributed duration into the smallest legal H3
// window. The incoming overlap is part of the sampled window, but is removed
// when segments are assembled, so it must be added before H3 frame alignment.
export function alignedLengthAtLeast(frames, minimum = 5) {
  const lower = 5 + 17 * Math.max(0, Math.ceil((minimum - 5) / 17));
  const requested = Math.max(lower, Math.ceil(Number(frames) - 1e-9));
  const steps = Math.max(
    0,
    Math.ceil((requested - 5) / 17 - 1e-12)
  );

  return Math.min(MAX_LENGTH, 5 + 17 * steps);
}

export function incomingOverlapFrames(windows, index) {
  if (index <= 0 || !windows[index] || !windows[index - 1]) {
    return 0;
  }

  return Math.max(
    0,
    windows[index - 1].endFrame - windows[index].startFrame
  );
}

// requestedFrames is the desired output contribution after overlap removal.
// Later windows ripple by the same delta, preserving their lengths and seams.
export function setWindowContributionDuration(
  windows,
  index,
  requestedFrames
) {
  const result = windows.map(segment => ({ ...segment }));
  const segment = result[index];

  if (!segment) return result;

  const overlap = incomingOverlapFrames(result, index);
  const desired = Math.max(
    1,
    Math.ceil(Number(requestedFrames) - 1e-9)
  );

  const minWindowLength = Math.max(5, overlap + 1);
  const newLength = alignedLengthAtLeast(
    desired + overlap,
    minWindowLength
  );

  const oldEnd = segment.endFrame;

  segment.endFrame = segment.startFrame + newLength;
  segment.requestedDurationFrames = desired;

  const delta = segment.endFrame - oldEnd;

  for (let i = index + 1; i < result.length; i++) {
    result[i].startFrame += delta;
    result[i].endFrame += delta;
  }

  return result;
}

export function requestedContributionFrames(windows, index) {
  const segment = windows[index];

  if (!segment) return 0;

  const actual =
    segment.endFrame -
    segment.startFrame -
    incomingOverlapFrames(windows, index);

  return Number.isInteger(segment.requestedDurationFrames)
    ? segment.requestedDurationFrames
    : actual;
}

// Backward-compatible export required by the timeline director.
export function minimumAlignedLength(frames, minimum = 5) {
  return alignedLengthAtLeast(frames, minimum);
}
