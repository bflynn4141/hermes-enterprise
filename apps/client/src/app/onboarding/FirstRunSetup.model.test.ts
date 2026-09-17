import {
  createFirstRunState,
  firstRunReducer,
  selectedLoop,
  workingAgreement,
  type FirstRunAction,
  type FirstRunState,
} from './FirstRunSetup.model.js';

function run(...actions: FirstRunAction[]): FirstRunState {
  return actions.reduce(firstRunReducer, createFirstRunState());
}

describe('first-run setup state', () => {
  it('builds the Partner Program loop without inventing criteria or external actions', () => {
    const state = run(
      { type: 'role/select', id: 'partner-program', label: 'Partner Program' },
      { type: 'loop/select', id: 'screen-partners' },
      { type: 'loop/confirm' },
      { type: 'reviewers/confirm' },
    );
    const agreement = workingAgreement(state);

    expect(state.step).toBe('test');
    expect(selectedLoop(state)?.label).toBe('Discover and screen partners');
    expect(agreement).toMatchObject({
      goal: 'Find strong Hermes partners',
      trigger: 'A person, company, or profile URL is submitted',
      inputs: 'Program criteria and public evidence',
      stages: ['Discovery', 'Public research', 'Evidence brief', 'Human review'],
      done: 'A cited brief is waiting for the right reviewer',
      readyForTest: true,
    });
    expect(agreement.reviews.map((boundary) => boundary.label)).toEqual([
      'Advance or dismiss a partner prospect',
      'Assign or change role and benefits',
      'Send an external message',
      'Sign an agreement or pay an invoice',
    ]);
  });

  it('keeps reviewer edits in the typed state passed to persistence', () => {
    const state = run(
      { type: 'role/select', id: 'partner-program', label: 'Partner Program' },
      { type: 'loop/select', id: 'screen-partners' },
      { type: 'loop/confirm' },
      { type: 'reviewers/edit' },
      { type: 'reviewers/change', id: 'external-message', reviewer: 'Workspace admin' },
      { type: 'reviewers/confirm' },
    );

    expect(state.reviewers['external-message']).toBe('Workspace admin');
    expect(workingAgreement(state).reviews.find((boundary) => boundary.id === 'external-message')?.reviewer).toBe('Workspace admin');
  });

  it('clears dependent answers when the role changes', () => {
    const partner = run(
      { type: 'role/select', id: 'partner-program', label: 'Partner Program' },
      { type: 'loop/select', id: 'screen-partners' },
      { type: 'loop/confirm' },
    );
    const changed = firstRunReducer(partner, { type: 'role/select', id: 'procurement', label: 'Procurement' });

    expect(changed).toMatchObject({ step: 'loop', roleId: 'procurement', roleLabel: 'Procurement', loopId: null, loopConfirmed: false });
    expect(workingAgreement(changed).reviews).toEqual([]);
  });
});
