export const FIRST_RUN_STEPS = ['role', 'loop', 'boundaries', 'test'] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export type RoleId = 'partner-program' | 'customer-success' | 'customer-onboarding' | 'procurement' | 'custom';
export type LoopId =
  | 'screen-partners'
  | 'onboard-partners'
  | 'support-partners'
  | 'triage-accounts'
  | 'prepare-success-reviews'
  | 'onboard-customers'
  | 'coordinate-launches'
  | 'review-vendors'
  | 'prepare-renewals'
  | 'custom-loop';

export interface RoleOption {
  id: RoleId;
  label: string;
}

export interface LoopOption {
  id: LoopId;
  label: string;
  goal: string;
  stages: readonly string[];
  done: string;
}

export type BoundaryId = 'admission' | 'role-benefits' | 'external-message' | 'agreement-money';
export type Reviewer = 'You' | 'Workspace admin' | 'Admin + Finance';

export interface ReviewBoundary {
  id: BoundaryId;
  label: string;
  reviewer: Reviewer;
}

export interface FirstRunState {
  step: FirstRunStep;
  roleId: RoleId | null;
  roleLabel: string;
  loopId: LoopId | null;
  loopConfirmed: boolean;
  reviewers: Record<BoundaryId, Reviewer>;
  editingReviewers: boolean;
}

export type FirstRunAction =
  | { type: 'role/select'; id: RoleId; label: string }
  | { type: 'role/custom'; label: string }
  | { type: 'loop/select'; id: LoopId }
  | { type: 'loop/adjust' }
  | { type: 'loop/confirm' }
  | { type: 'reviewers/edit' }
  | { type: 'reviewers/change'; id: BoundaryId; reviewer: Reviewer }
  | { type: 'reviewers/confirm' }
  | { type: 'step/back' }
  | { type: 'reset' };

export const ROLE_OPTIONS: readonly RoleOption[] = [
  { id: 'partner-program', label: 'Partner Program' },
  { id: 'customer-success', label: 'Customer Success' },
  { id: 'customer-onboarding', label: 'Customer Onboarding' },
  { id: 'procurement', label: 'Procurement' },
  { id: 'custom', label: 'Something else' },
];

export const LOOP_OPTIONS: Record<Exclude<RoleId, 'custom'>, readonly LoopOption[]> = {
  'partner-program': [
    { id: 'screen-partners', label: 'Discover and screen partners', goal: 'Find strong Hermes partners', stages: ['Discovery', 'Public research', 'Evidence brief', 'Human review'], done: 'A cited brief is waiting for the right reviewer' },
    { id: 'onboard-partners', label: 'Onboard accepted partners', goal: 'Give accepted partners a clear start', stages: ['Acceptance', 'Checklist', 'Materials', 'Human review'], done: 'An onboarding plan is waiting for its owner' },
    { id: 'support-partners', label: 'Support active partners', goal: 'Resolve partner needs with context', stages: ['Request', 'Research', 'Proposed response', 'Human review'], done: 'A grounded response is waiting for review' },
  ],
  'customer-success': [
    { id: 'triage-accounts', label: 'Triage account risks', goal: 'Surface customer risks early', stages: ['Signal', 'Research', 'Risk brief', 'Human review'], done: 'A risk brief is waiting for the account owner' },
    { id: 'prepare-success-reviews', label: 'Prepare success reviews', goal: 'Make customer reviews evidence-led', stages: ['Account', 'Research', 'Review brief', 'Human review'], done: 'A cited review is waiting for the account owner' },
  ],
  'customer-onboarding': [
    { id: 'onboard-customers', label: 'Prepare customer onboarding', goal: 'Give each customer a clear start', stages: ['Customer', 'Requirements', 'Onboarding plan', 'Human review'], done: 'An onboarding plan is waiting for its owner' },
    { id: 'coordinate-launches', label: 'Coordinate customer launches', goal: 'Keep launches moving with clear owners', stages: ['Launch', 'Dependencies', 'Readiness brief', 'Human review'], done: 'A readiness brief is waiting for the launch owner' },
  ],
  procurement: [
    { id: 'review-vendors', label: 'Review new vendors', goal: 'Evaluate vendors with consistent evidence', stages: ['Vendor', 'Research', 'Vendor brief', 'Human review'], done: 'A vendor brief is waiting for the right reviewer' },
    { id: 'prepare-renewals', label: 'Prepare vendor renewals', goal: 'Make renewal decisions evidence-led', stages: ['Renewal', 'Usage research', 'Renewal brief', 'Human review'], done: 'A renewal brief is waiting for the right reviewer' },
  ],
};

export const DEFAULT_BOUNDARIES: readonly ReviewBoundary[] = [
  { id: 'admission', label: 'Advance or dismiss a partner prospect', reviewer: 'You' },
  { id: 'role-benefits', label: 'Assign or change role and benefits', reviewer: 'You' },
  { id: 'external-message', label: 'Send an external message', reviewer: 'You' },
  { id: 'agreement-money', label: 'Sign an agreement or pay an invoice', reviewer: 'Admin + Finance' },
];

const GENERAL_BOUNDARIES: readonly ReviewBoundary[] = [
  { id: 'admission', label: 'Approve an outcome or commitment', reviewer: 'You' },
  { id: 'role-benefits', label: 'Change access, roles, or benefits', reviewer: 'You' },
  { id: 'external-message', label: 'Send an external message', reviewer: 'You' },
  { id: 'agreement-money', label: 'Sign an agreement or pay an invoice', reviewer: 'Admin + Finance' },
];

export const REVIEWER_OPTIONS: readonly Reviewer[] = ['You', 'Workspace admin', 'Admin + Finance'];

export function createFirstRunState(): FirstRunState {
  return {
    step: 'role',
    roleId: null,
    roleLabel: '',
    loopId: null,
    loopConfirmed: false,
    reviewers: Object.fromEntries(DEFAULT_BOUNDARIES.map((boundary) => [boundary.id, boundary.reviewer])) as Record<BoundaryId, Reviewer>,
    editingReviewers: false,
  };
}

export function loopsForRole(roleId: RoleId | null): readonly LoopOption[] {
  if (!roleId || roleId === 'custom') {
    return [{ id: 'custom-loop', label: 'Describe the first loop', goal: 'Turn a repeated responsibility into a clear loop', stages: ['Input', 'Research', 'Draft', 'Human review'], done: 'A reviewable result is waiting for its owner' }];
  }
  return LOOP_OPTIONS[roleId];
}

export function boundariesForRole(roleId: RoleId | null): readonly ReviewBoundary[] {
  return roleId === 'partner-program' ? DEFAULT_BOUNDARIES : GENERAL_BOUNDARIES;
}

export function selectedLoop(state: Pick<FirstRunState, 'roleId' | 'loopId'>): LoopOption | null {
  return loopsForRole(state.roleId).find((loop) => loop.id === state.loopId) ?? null;
}

export function firstRunReducer(state: FirstRunState, action: FirstRunAction): FirstRunState {
  switch (action.type) {
    case 'role/select':
      return { ...createFirstRunState(), step: 'loop', roleId: action.id, roleLabel: action.label };
    case 'role/custom': {
      const label = action.label.trim();
      if (!label) return state;
      return { ...createFirstRunState(), step: 'loop', roleId: 'custom', roleLabel: label };
    }
    case 'loop/select':
      return { ...state, loopId: action.id, loopConfirmed: false };
    case 'loop/adjust':
      return { ...state, loopId: null, loopConfirmed: false };
    case 'loop/confirm':
      return state.loopId ? { ...state, step: 'boundaries', loopConfirmed: true } : state;
    case 'reviewers/edit':
      return { ...state, editingReviewers: true };
    case 'reviewers/change':
      return { ...state, reviewers: { ...state.reviewers, [action.id]: action.reviewer } };
    case 'reviewers/confirm':
      return { ...state, step: 'test', editingReviewers: false };
    case 'step/back':
      if (state.step === 'test') return { ...state, step: 'boundaries' };
      if (state.step === 'boundaries') return { ...state, step: 'loop', editingReviewers: false };
      if (state.step === 'loop') return { ...createFirstRunState() };
      return state;
    case 'reset':
      return createFirstRunState();
  }
}

export interface WorkingAgreement {
  goal: string | null;
  trigger: string | null;
  inputs: string | null;
  stages: readonly string[];
  reviews: readonly ReviewBoundary[];
  done: string | null;
  readyForTest: boolean;
}

export function workingAgreement(state: FirstRunState): WorkingAgreement {
  const loop = selectedLoop(state);
  const isPartnerScreening = state.loopId === 'screen-partners';
  return {
    goal: loop?.goal ?? (state.roleLabel ? `Support ${state.roleLabel}` : null),
    trigger: state.loopConfirmed ? 'A person, company, or profile URL is submitted' : null,
    inputs: loop ? (isPartnerScreening ? 'Program criteria and public evidence' : 'Your criteria and available evidence') : null,
    stages: loop?.stages ?? [],
    reviews: state.loopConfirmed
      ? boundariesForRole(state.roleId).map((boundary) => ({ ...boundary, reviewer: state.reviewers[boundary.id] }))
      : [],
    done: loop?.done ?? null,
    readyForTest: state.step === 'test',
  };
}
