import { describe, it, expect } from 'vitest';
import { GitLabCITarget } from './target.js';

const target = new GitLabCITarget();

// Access private methods for unit testing
const renderJob = (target as any).renderJob.bind(target);
const mergeWorkflowRules = (target as any).mergeWorkflowRules.bind(target);
const renderCache = (target as any).renderCache.bind(target);

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test',
    name: 'test',
    needs: [] as string[],
    steps: [],
    secrets: [] as string[],
    ...overrides,
  };
}

const minimalAst = { functionName: 'myWorkflow', options: { cicd: {} } } as any;

describe('Bug 4: retry.when rendering', () => {
  it('renders retry with when array when retryWhen is set', () => {
    const job = makeJob({ retry: 2, retryWhen: ['runner_system_failure', 'api_failure'] });
    const result = renderJob(job, minimalAst, ['test']);

    expect(result.retry).toEqual({
      max: 2,
      when: ['runner_system_failure', 'api_failure'],
    });
  });

  it('renders retry without when when retryWhen is not set', () => {
    const job = makeJob({ retry: 1 });
    const result = renderJob(job, minimalAst, ['test']);

    expect(result.retry).toEqual({ max: 1 });
    expect(result.retry.when).toBeUndefined();
  });

  it('omits retry entirely when not configured', () => {
    const job = makeJob();
    const result = renderJob(job, minimalAst, ['test']);

    expect(result.retry).toBeUndefined();
  });
});

describe('Bug 5: workflow rule merging', () => {
  it('places when=never rules before trigger rules', () => {
    const customRules = [
      { if: '$CI_COMMIT_MESSAGE =~ /\\[ci skip\\]/', when: 'never' },
      { when: 'always' },
    ];
    const triggerRules = [
      { if: '$CI_COMMIT_BRANCH == "main"', when: 'always' },
    ];

    const result = mergeWorkflowRules(customRules, triggerRules);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ if: '$CI_COMMIT_MESSAGE =~ /\\[ci skip\\]/', when: 'never' });
    expect(result[1]).toEqual({ if: '$CI_COMMIT_BRANCH == "main"', when: 'always' });
    expect(result[2]).toEqual({ when: 'always' });
  });

  it('returns trigger rules unchanged when no custom rules', () => {
    const triggerRules = [{ if: '$CI_PIPELINE_SOURCE == "push"', when: 'always' }];
    const result = mergeWorkflowRules([], triggerRules);

    expect(result).toEqual(triggerRules);
  });

  it('handles only never rules (no always)', () => {
    const customRules = [
      { if: '$CI_COMMIT_MESSAGE =~ /skip/', when: 'never' },
    ];
    const result = mergeWorkflowRules(customRules, []);

    expect(result).toHaveLength(1);
    expect(result[0].when).toBe('never');
  });

  it('includes changes in rule objects', () => {
    const customRules = [
      { if: '$CI_COMMIT_BRANCH', changes: ['src/**', 'lib/**'], when: 'always' },
    ];
    const result = mergeWorkflowRules(customRules, []);

    expect(result[0].changes).toEqual(['src/**', 'lib/**']);
  });

  it('places catch-all when=never (no if:) AFTER triggers', () => {
    const customRules = [
      { if: '$CI_COMMIT_MESSAGE =~ /skip/', when: 'never' },
      { when: 'never' },
    ];
    const triggerRules = [
      { if: '$CI_PIPELINE_SOURCE == "push"', when: 'always' },
    ];

    const result = mergeWorkflowRules(customRules, triggerRules);

    // Conditional never (with if:) goes before triggers
    expect(result[0]).toEqual({ if: '$CI_COMMIT_MESSAGE =~ /skip/', when: 'never' });
    // Trigger rules in the middle
    expect(result[1]).toEqual({ if: '$CI_PIPELINE_SOURCE == "push"', when: 'always' });
    // Catch-all never (no if:) goes after triggers
    expect(result[2]).toEqual({ when: 'never' });
  });
});

describe('Bug 6: parallel: N rendering', () => {
  it('renders numeric parallel value', () => {
    const job = makeJob({ parallel: 5 });
    const result = renderJob(job, minimalAst, ['test']);
    expect(result.parallel).toBe(5);
  });

  it('does not render parallel when matrix is present', () => {
    const job = makeJob({ parallel: 5, matrix: { dimensions: { NODE: ['16', '18'] } } });
    const result = renderJob(job, minimalAst, ['test']);
    // Should render matrix form, not numeric
    expect(result.parallel).toEqual({ matrix: [{ NODE: ['16', '18'] }] });
  });
});

describe('Bug 7: optionalNeeds rendering', () => {
  it('renders optional needs as { job: X, optional: true }', () => {
    const job = makeJob({
      needs: ['lint', 'build'],
      optionalNeeds: ['lint'],
    });
    const result = renderJob(job, minimalAst, ['test']);
    expect(result.needs).toEqual([
      { job: 'lint', optional: true },
      { job: 'build' },
    ]);
  });

  it('renders plain string needs when no optionalNeeds', () => {
    const job = makeJob({ needs: ['lint', 'build'] });
    const result = renderJob(job, minimalAst, ['test']);
    expect(result.needs).toEqual(['lint', 'build']);
  });
});

describe('Bug 8: skipDependencies rendering', () => {
  it('renders dependencies: [] when skipDependencies is true', () => {
    const job = makeJob({ skipDependencies: true });
    const result = renderJob(job, minimalAst, ['test']);
    expect(result.dependencies).toEqual([]);
  });

  it('omits dependencies when skipDependencies is not set', () => {
    const job = makeJob();
    const result = renderJob(job, minimalAst, ['test']);
    expect(result.dependencies).toBeUndefined();
  });
});

describe('Bug 9: renderCache with files, policy, and comma paths', () => {
  it('renders cache.files as key: { files: [...] }', () => {
    const result = renderCache({ strategy: 'custom', files: ['yarn.lock', 'package.json'] });
    expect(result.key).toEqual({ files: ['yarn.lock', 'package.json'] });
  });

  it('renders cache.policy', () => {
    const result = renderCache({ strategy: 'npm', policy: 'pull-push' });
    expect(result.policy).toBe('pull-push');
  });

  it('splits comma-separated paths', () => {
    const result = renderCache({ strategy: 'custom', path: 'node_modules/,.npm/' });
    expect(result.paths).toEqual(['node_modules/', '.npm/']);
  });

  it('splits comma-separated paths for npm strategy', () => {
    const result = renderCache({ strategy: 'npm', path: 'node_modules/,.cache/' });
    expect(result.paths).toEqual(['node_modules/', '.cache/']);
  });

  it('uses default path when none provided', () => {
    const result = renderCache({ strategy: 'npm' });
    expect(result.paths).toEqual(['node_modules/']);
  });
});
