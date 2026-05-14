export type SeatSummary = {
  subject: string;
  courseNumber: string;
  section: string;
  crn: string;
  title: string;
  /** Raw text from the Class Seats column */
  seatsText: string;
  /** Best-effort parse: enrolled / capacity if detectable */
  enrolled?: number;
  capacity?: number;
  /** Waitlist enrolled / capacity if detectable */
  waitEnrolled?: number;
  waitCapacity?: number;
};

export type WatchRequest = {
  /** e.g. "Spring 2026" — must match the label in the term dropdown */
  termLabel: string;
  /** e.g. "CP" */
  subject: string;
  /** e.g. "217" */
  courseNumber: string;
  /** If set, only this CRN row is considered a match */
  crn?: string;
  /** Where to send availability / waitlist alerts */
  notifyEmail: string;
};

export type CheckResult = {
  termLabel: string;
  subject: string;
  courseNumber: string;
  matched: SeatSummary[];
  /** STORAGE_STATE_MISSING | SESSION_OR_LOGIN | FLOW_FAILED */
  error?: string;
  /** Populated when error === FLOW_FAILED or for diagnostics */
  detail?: string;
};
