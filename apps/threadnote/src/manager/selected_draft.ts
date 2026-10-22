// Keep existing Manager callers on the same selected-provider implementation as headless work.
export {
  runSelectedDraft,
  selectedTopicDraftIdentity,
  SelectedDraftError,
  TOPIC_DRAFT_PROMPT_VERSION,
  TOPIC_DRAFT_MAX_PROMPT_BYTES,
  TOPIC_DRAFT_MAX_OUTPUT_BYTES,
  TOPIC_DRAFT_MAX_DURATION_MS,
  type SelectedDraftResult,
} from '../effect/ai/selected_generation.js';
