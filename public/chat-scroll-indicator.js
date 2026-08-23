const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function chatScrollThumbMetrics({
  scrollTop = 0,
  scrollStart = 0,
  scrollEnd = 0,
  contentHeight = 0,
  visibleHeight = 0,
  trackHeight = 0,
  minimumThumbHeight = 38,
} = {}) {
  const safeTrackHeight = Math.max(0, Number(trackHeight) || 0);
  const safeContentHeight = Math.max(0, Number(contentHeight) || 0);
  const safeVisibleHeight = Math.max(0, Number(visibleHeight) || 0);
  if (!safeTrackHeight || safeContentHeight <= safeVisibleHeight + 2) {
    return { visible: false, thumbHeight: safeTrackHeight, thumbOffset: 0, progress: 1 };
  }

  const thumbHeight = clamp(
    safeTrackHeight * (safeVisibleHeight / safeContentHeight),
    Math.min(minimumThumbHeight, safeTrackHeight),
    safeTrackHeight,
  );
  const range = Math.max(0, Number(scrollEnd) - Number(scrollStart));
  const progress = range
    ? clamp((Number(scrollTop) - Number(scrollStart)) / range, 0, 1)
    : 1;

  return {
    visible: thumbHeight < safeTrackHeight - 1,
    thumbHeight,
    thumbOffset: (safeTrackHeight - thumbHeight) * progress,
    progress,
  };
}
