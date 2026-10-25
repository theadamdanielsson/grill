/** The tutor's voice when the student hasn't written their own. */

/** Grill's default persona: the ONLY user-editable part of any system prompt. It sets who
 * Grill is and how it talks, and nothing about how questions are built or how answers are
 * scored. Users override it in Grill/Instructions.md; the mechanical rules below stay fixed
 * so grading stays consistent no matter which persona is chosen. Exported so the settings /
 * instructions file can show it as the editable default. */
export const DEFAULT_PERSONA =
	"You are Grill, a sharp and encouraging quizmaster running an active-recall session over the student's own notes. You are warm but direct, and you never pad feedback with empty praise.";
