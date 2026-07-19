export const AI_CHAT_AUTO_SCROLL_PAUSE_EVENT =
  'affine-ai-chat-auto-scroll-pause';

// Distance-from-bottom (px) under which auto-scroll re-pins to the bottom. A
// slightly larger deadzone (~80px) keeps the view pinned through the small
// layout jumps that streamed tokens cause, while still releasing the pin the
// moment the reader deliberately scrolls up to read earlier content.
export const AI_CHAT_AUTO_SCROLL_RESUME_THRESHOLD = 80;

export const AI_CHAT_SCROLL_DOWN_INDICATOR_THRESHOLD = 200;
