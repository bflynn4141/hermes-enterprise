export const FIRST_RUN_STEPS = ['intro', 'criteria', 'boundaries', 'ready'] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export type BoundaryId = 'admission' | 'role-benefits' | 'external-message' | 'agreement-money';
export type Reviewer = 'You' | 'Workspace admin' | 'Admin + Finance';

export interface ReviewBoundary {
  id: BoundaryId;
  label: string;
  reviewer: Reviewer;
}

export interface FirstRunState {
  step: FirstRunStep;
  partnerCriteria: string;
  reviewers: Record<BoundaryId, Reviewer>;
  editingReviewers: boolean;
}

export type FirstRunAction =
  | { type: 'intro/continue' }
  | { type: 'criteria/change'; value: string }
  | { type: 'criteria/confirm' }
  | { type: 'reviewers/edit' }
  | { type: 'reviewers/change'; id: BoundaryId; reviewer: Reviewer }
  | { type: 'reviewers/confirm' }
  | { type: 'step/back' }
  | { type: 'reset' };

export const DEFAULT_CRITERIA =
  'Technical leaders and organizations building useful products with open AI models, with clear ecosystem relevance and trustworthy public professional evidence.';

export const DEFAULT_BOUNDARIES: readonly ReviewBoundary[] = [
  { id: 'admission', label: 'Advance or dismiss a partner prospect', reviewer: 'You' },
  { id: 'role-benefits', label: 'Assign or change role and benefits', reviewer: 'You' },
  { id: 'external-message', label: 'Send an external message', reviewer: 'You' },
  { id: 'agreement-money', label: 'Sign an agreement or move money', reviewer: 'Admin + Finance' },
];

export const REVIEWER_OPTIONS: readonly Reviewer[] = ['You', 'Workspace admin', 'Admin + Finance'];

export function createFirstRunState(): FirstRunState {
  return {
    step: 'intro',
    partnerCriteria: DEFAULT_CRITERIA,
    reviewers: Object.fromEntries(DEFAULT_BOUNDARIES.map((boundary) => [boundary.id, boundary.reviewer])) as Record<BoundaryId, Reviewer>,
    editingReviewers: false,
  };
}

export function firstRunReducer(state: FirstRunState, action: FirstRunAction): FirstRunState {
  switch (action.type) {
    case 'intro/continue':
      return { ...state, step: 'criteria' };
    case 'criteria/change':
      return { ...state, partnerCriteria: action.value };
    case 'criteria/confirm':
      return state.partnerCriteria.trim().length >= 10 ? { ...state, step: 'boundaries' } : state;
    case 'reviewers/edit':
      return { ...state, editingReviewers: true };
    case 'reviewers/change':
      return { ...state, reviewers: { ...state.reviewers, [action.id]: action.reviewer } };
    case 'reviewers/confirm':
      return { ...state, step: 'ready', editingReviewers: false };
    case 'step/back':
      if (state.step === 'ready') return { ...state, step: 'boundaries' };
      if (state.step === 'boundaries') return { ...state, step: 'criteria', editingReviewers: false };
      if (state.step === 'criteria') return { ...state, step: 'intro' };
      return state;
    case 'reset':
      return createFirstRunState();
  }
}

export interface WorkingAgreement {
  goal: string;
  trigger: string;
  inputs: string;
  stages: readonly string[];
  reviews: readonly ReviewBoundary[];
  done: string;
  readyForWork: boolean;
}

export function workingAgreement(state: FirstRunState): WorkingAgreement {
  return {
    goal: 'Find strong Partner Program prospects',
    trigger: 'You approve the first capped search or submit a prospect',
    inputs: state.partnerCriteria.trim(),
    stages: ['Discovery', 'Public research', 'Evidence brief', 'Human review'],
    reviews: DEFAULT_BOUNDARIES.map((boundary) => ({ ...boundary, reviewer: state.reviewers[boundary.id] })),
    done: 'A cited brief is waiting in Inbox; no one has been contacted',
    readyForWork: state.step === 'ready',
  };
}
