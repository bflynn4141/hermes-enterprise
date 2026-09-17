import {
  createFirstRunState,
  firstRunReducer,
  workingAgreement,
  type FirstRunAction,
  type FirstRunState,
} from './FirstRunSetup.model.js';

function run(...actions: FirstRunAction[]): FirstRunState {
  return actions.reduce(firstRunReducer, createFirstRunState());
}

describe('invited Partner Program activation', () => {
  it('offers one fixed workflow and stores real partner criteria', () => {
    const state = run(
      { type: 'intro/continue' },
      { type: 'criteria/change', value: 'Developer-tool founders using open models in North America.' },
      { type: 'criteria/confirm' },
      { type: 'reviewers/confirm' },
    );
    expect(state.step).toBe('ready');
    expect(workingAgreement(state)).toMatchObject({
      goal: 'Find strong Partner Program prospects',
      inputs: 'Developer-tool founders using open models in North America.',
      stages: ['Discovery', 'Public research', 'Evidence brief', 'Human review'],
      readyForWork: true,
    });
  });

  it('keeps reviewer edits in the agreement sent to persistence', () => {
    const state = run(
      { type: 'intro/continue' },
      { type: 'criteria/confirm' },
      { type: 'reviewers/edit' },
      { type: 'reviewers/change', id: 'external-message', reviewer: 'Workspace admin' },
      { type: 'reviewers/confirm' },
    );
    expect(workingAgreement(state).reviews.find((row) => row.id === 'external-message')?.reviewer).toBe('Workspace admin');
  });

  it('does not advance with empty criteria', () => {
    const state = run(
      { type: 'intro/continue' },
      { type: 'criteria/change', value: 'short' },
      { type: 'criteria/confirm' },
    );
    expect(state.step).toBe('criteria');
  });
});
