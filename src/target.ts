/**
 * GitLab CI Export Target
 *
 * Generates .gitlab-ci.yml from a Flow Weaver CI/CD workflow.
 * Each job runs the compiled workflow code via `node dist/<name>.cicd.js --job=<id>`,
 * with native GitLab CI handling orchestration (triggers, dependencies,
 * runners, secrets, caches, artifacts).
 *
 * Key differences from GitHub Actions:
 * - `stage:` instead of job `needs:` (generates `stages:` list)
 * - `$CI_VARIABLE` instead of `${{ secrets.NAME }}`
 * - `cache:` and `artifacts:` as native YAML keywords (no separate actions)
 * - `services:` as native keyword
 * - `rules:` for conditional execution
 * - `environment:` as native keyword with `url:` and `when: manual` for approval
 */

import { stringify as yamlStringify } from 'yaml';
import type { TWorkflowAST } from '@synergenius/flow-weaver/ast';
import {
  isCICDWorkflow,
  buildJobGraph,
  resolveJobSecrets,
  injectArtifactSteps,
  generateSecretsDoc,
  type CICDJob,
} from '@synergenius/flowweaver-pack-cicd';
import type {
  ExportOptions,
  ExportArtifacts,
  DeployInstructions,
  MultiWorkflowArtifacts,
  CompiledWorkflow,
  NodeTypeArtifacts,
  NodeTypeInfo,
  NodeTypeExportOptions,
  BundleArtifacts,
  BundleWorkflow,
  BundleNodeType,
} from '@synergenius/flow-weaver/deployment';
import { BaseExportTarget } from '@synergenius/flow-weaver/deployment';
import { parseWorkflow } from '@synergenius/flow-weaver/api';
import * as path from 'path';

export class GitLabCITarget extends BaseExportTarget {
  readonly name = 'gitlab-ci';
  readonly description = 'GitLab CI/CD pipeline (.gitlab-ci.yml)';

  /** Accumulated warnings for the current export run */
  private _warnings: string[] = [];

  readonly deploySchema = {
    runner: { type: 'string' as const, description: 'Default Docker image', default: 'ubuntu:latest' },
  };

  readonly nodeTypeDeploySchema = {
    script: { type: 'string[]' as const, description: 'GitLab CI script commands' },
    image: { type: 'string' as const, description: 'Docker image override' },
    label: { type: 'string' as const, description: 'Step display name' },
  };

  async generate(options: ExportOptions): Promise<ExportArtifacts> {
    this._warnings = [];
    const filePath = path.resolve(options.sourceFile);
    const outputDir = path.resolve(options.outputDir);

    const parseResult = await parseWorkflow(filePath, { nodeTypesOnly: false });
    if (parseResult.errors.length > 0) {
      throw new Error(`Parse errors: ${parseResult.errors.join('; ')}`);
    }

    const allWorkflows = parseResult.allWorkflows || [];
    const targetWorkflows = options.workflowName
      ? allWorkflows.filter((w) => w.name === options.workflowName || w.functionName === options.workflowName)
      : allWorkflows.filter((w) => isCICDWorkflow(w));

    if (targetWorkflows.length === 0) {
      throw new Error('No CI/CD workflows found. Ensure workflow has CI/CD annotations (@secret, @runner, @trigger, [job:], etc.)');
    }

    const files = [];

    for (const ast of targetWorkflows) {
      const jobs = buildJobGraph(ast);
      resolveJobSecrets(jobs, ast, (name) => `$${name}`);

      const artifacts = ast.options?.cicd?.artifacts || [];
      injectArtifactSteps(jobs, artifacts);
      this.applyWorkflowOptions(jobs, ast);

      const yamlContent = this.renderPipelineYAML(ast, jobs);
      files.push(this.createFile(outputDir, '.gitlab-ci.yml', yamlContent, 'config'));

      const secrets = ast.options?.cicd?.secrets || [];
      if (secrets.length > 0) {
        const secretsDoc = generateSecretsDoc(secrets, 'gitlab-ci');
        files.push(this.createFile(outputDir, 'SECRETS_SETUP.md', secretsDoc, 'other'));
      }
    }

    // Warn about @concurrency (no direct GitLab equivalent)
    for (const ast of targetWorkflows) {
      if (ast.options?.cicd?.concurrency) {
        this._warnings.push(
          `@concurrency: GitLab CI has no direct concurrency group equivalent. Use resource_group for serial execution or interruptible for auto-cancellation.`
        );
      }
    }

    return {
      files,
      target: this.name,
      workflowName: options.displayName || targetWorkflows[0].name,
      entryPoint: files[0].relativePath,
      warnings: this._warnings.length > 0 ? this._warnings : undefined,
    };
  }

  async generateMultiWorkflow(
    _workflows: CompiledWorkflow[],
    _options: ExportOptions,
  ): Promise<MultiWorkflowArtifacts> {
    throw new Error('CI/CD targets use generate() with AST, not generateMultiWorkflow()');
  }

  async generateNodeTypeService(
    _nodeTypes: NodeTypeInfo[],
    _options: NodeTypeExportOptions,
  ): Promise<NodeTypeArtifacts> {
    throw new Error('CI/CD targets do not export node types as services');
  }

  async generateBundle(
    _workflows: BundleWorkflow[],
    _nodeTypes: BundleNodeType[],
    _options: ExportOptions,
  ): Promise<BundleArtifacts> {
    throw new Error('CI/CD targets use generate() with AST, not generateBundle()');
  }

  getDeployInstructions(_artifacts: ExportArtifacts): DeployInstructions {
    return {
      title: 'Deploy GitLab CI Pipeline',
      prerequisites: [
        'GitLab repository',
        'CI/CD variables configured (see SECRETS_SETUP.md)',
        'GitLab Runner available (shared or project-specific)',
      ],
      steps: [
        'Copy .gitlab-ci.yml to your repository root',
        'Build your workflow: npx flow-weaver compile --target cicd <workflow>.ts',
        'Configure required variables in GitLab (Settings > CI/CD > Variables)',
        'Push to trigger the pipeline',
      ],
      localTestSteps: [
        'Install gitlab-runner: brew install gitlab-runner',
        'Run locally: gitlab-runner exec docker <job-name>',
      ],
      links: [
        { label: 'GitLab CI/CD Docs', url: 'https://docs.gitlab.com/ee/ci/' },
        { label: 'GitLab CI Lint', url: 'https://docs.gitlab.com/ee/ci/lint.html' },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Private: YAML Rendering
  // ---------------------------------------------------------------------------

  private renderPipelineYAML(ast: TWorkflowAST, jobs: CICDJob[]): string {
    const doc: Record<string, unknown> = {};

    // include: directive (from @includes)
    const includes = ast.options?.cicd?.includes;
    if (includes && includes.length > 0) {
      doc.include = includes.map(inc => {
        switch (inc.type) {
          case 'local': return { local: inc.file };
          case 'template': return { template: inc.file };
          case 'remote': return { remote: inc.file };
          case 'project': {
            const obj: Record<string, string> = { project: inc.project || '', file: inc.file };
            if (inc.ref) obj.ref = inc.ref;
            return obj;
          }
          default: return { local: inc.file };
        }
      });
    }

    // stages (from @stage annotations or derived from dependency depth)
    const stages = this.deriveStages(jobs, ast);
    doc.stages = stages;

    // Default image
    const defaultImage = this.deriveDefaultImage(ast);
    if (defaultImage) {
      doc.default = { image: defaultImage };
    }

    // Workflow-level variables
    if (ast.options?.cicd?.variables && Object.keys(ast.options.cicd.variables).length > 0) {
      doc.variables = { ...ast.options.cicd.variables };
    }

    // Workflow-level before_script
    if (ast.options?.cicd?.beforeScript && ast.options.cicd.beforeScript.length > 0) {
      doc.before_script = ast.options.cicd.beforeScript;
    }

    // Workflow-level rules (from @rule + triggers)
    const triggerRules = this.renderWorkflowRules(ast.options?.cicd?.triggers || []);
    const customRules = (ast.options?.cicd as Record<string, unknown>)?.workflowRules as
      Array<{ if?: string; when?: string; changes?: string[] }> | undefined;
    const rules = this.mergeWorkflowRules(customRules || [], triggerRules);
    if (rules.length > 0) {
      doc.workflow = { rules };
    }

    // Job definitions
    for (const job of jobs) {
      doc[job.id] = this.renderJob(job, ast, stages);
    }

    return yamlStringify(doc, {
      lineWidth: 120,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    });
  }

  /**
   * Derive stages from @stage annotations or job dependency depth.
   *
   * When @stage annotations exist, jobs are grouped into named stages:
   * - Jobs with an explicit `stage` field (set by buildJobGraph from @stage/@job)
   *   use that stage name directly.
   * - The returned list preserves @stage declaration order.
   *
   * Without @stage annotations, falls back to using each job ID as its own stage
   * (ordered by dependency).
   */
  private deriveStages(jobs: CICDJob[], ast?: TWorkflowAST): string[] {
    const declaredStages = ast?.options?.cicd?.stages;

    // If @stage annotations exist, use them
    if (declaredStages && declaredStages.length > 0) {
      const stageNames = declaredStages.map(s => s.name);

      // Collect any stages referenced by jobs that aren't in the declared list
      for (const job of jobs) {
        if (job.stage && !stageNames.includes(job.stage)) {
          stageNames.push(job.stage);
        }
      }

      return stageNames;
    }

    // Fallback: use job IDs as stage names, ordered by dependency
    const stages: string[] = [];
    for (const job of jobs) {
      if (!stages.includes(job.id)) {
        stages.push(job.id);
      }
    }

    return stages;
  }

  /**
   * Derive default image from @runner annotation.
   */
  private deriveDefaultImage(ast: TWorkflowAST): string | undefined {
    const runner = ast.options?.cicd?.runner;
    if (runner) {
      return this.mapRunnerToImage(runner);
    }
    return undefined;
  }

  /**
   * Map GitHub-style runner labels to Docker images.
   */
  private mapRunnerToImage(runner: string): string {
    const imageMap: Record<string, string> = {
      'ubuntu-latest': 'ubuntu:latest',
      'ubuntu-22.04': 'ubuntu:22.04',
      'ubuntu-20.04': 'ubuntu:20.04',
    };
    return imageMap[runner] || runner;
  }

  /**
   * Convert CI/CD triggers to GitLab CI workflow rules.
   */
  private renderWorkflowRules(
    triggers: Array<{ type: string; branches?: string[]; paths?: string[] }>,
  ): Array<Record<string, unknown>> {
    if (triggers.length === 0) return [];

    const rules: Array<Record<string, unknown>> = [];

    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'push':
          if (trigger.branches) {
            for (const branch of trigger.branches) {
              rules.push({
                if: `$CI_COMMIT_BRANCH == "${branch}"`,
                when: 'always',
              });
            }
          } else {
            rules.push({ if: '$CI_PIPELINE_SOURCE == "push"', when: 'always' });
          }
          break;
        case 'pull_request':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "merge_request_event"',
            when: 'always',
          });
          break;
        case 'schedule':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "schedule"',
            when: 'always',
          });
          break;
        case 'dispatch':
          rules.push({
            if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"',
            when: 'always',
          });
          break;
        case 'tag':
          rules.push({ if: '$CI_COMMIT_TAG', when: 'always' });
          break;
      }
    }

    return rules;
  }

  /**
   * Merge @rule entries with trigger-derived rules.
   * `when=never` rules go first (blockers), trigger rules in the middle,
   * then `when=always` rules last (first-match-wins semantics).
   */
  private mergeWorkflowRules(
    customRules: Array<{ if?: string; when?: string; changes?: string[] }>,
    triggerRules: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    if (customRules.length === 0) return triggerRules;

    const beforeRules: Array<Record<string, unknown>> = [];
    const afterRules: Array<Record<string, unknown>> = [];

    for (const rule of customRules) {
      const ruleObj: Record<string, unknown> = {};
      if (rule.if) ruleObj.if = rule.if;
      if (rule.when) ruleObj.when = rule.when;
      if (rule.changes) ruleObj.changes = rule.changes;

      if (rule.when === 'never') {
        beforeRules.push(ruleObj);
      } else {
        afterRules.push(ruleObj);
      }
    }

    return [...beforeRules, ...triggerRules, ...afterRules];
  }

  private renderJob(
    job: CICDJob,
    ast: TWorkflowAST,
    _stages: string[],
  ): Record<string, unknown> {
    const jobObj: Record<string, unknown> = {};

    // extends (from @job extends=".template-name")
    if (job.extends) {
      jobObj.extends = job.extends;
    }

    // stage (use explicit stage from @stage assignment, or fall back to job ID)
    jobObj.stage = job.stage || job.id;

    // image (from per-job runner override via @job X runner=Y)
    if (job.runner) {
      jobObj.image = this.mapRunnerToImage(job.runner);
    }

    // tags (from @job tags or @tags)
    if (job.tags && job.tags.length > 0) {
      jobObj.tags = job.tags;
    }

    // matrix strategy (parallel: matrix:)
    if (job.matrix) {
      const matrixEntries: Record<string, string[]>[] = [];
      if (job.matrix.dimensions && Object.keys(job.matrix.dimensions).length > 0) {
        matrixEntries.push(job.matrix.dimensions);
      }
      if (job.matrix.include) {
        for (const inc of job.matrix.include) {
          matrixEntries.push(
            Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, [v]])),
          );
        }
      }
      if (matrixEntries.length > 0) {
        jobObj.parallel = { matrix: matrixEntries };
      }
    }

    // needs (for DAG mode instead of stage-based ordering)
    if (job.needs.length > 0) {
      jobObj.needs = job.needs;
    }

    // retry (from @job retry + retry_when)
    if (job.retry !== undefined) {
      const retryObj: Record<string, unknown> = { max: job.retry };
      if (job.retryWhen && job.retryWhen.length > 0) {
        retryObj.when = job.retryWhen;
      }
      jobObj.retry = retryObj;
    }

    // allow_failure (from @job allow_failure)
    if (job.allowFailure) {
      jobObj.allow_failure = true;
    }

    // timeout (from @job timeout)
    if (job.timeout) {
      jobObj.timeout = job.timeout;
    }

    // rules (from @job rules)
    if (job.rules && job.rules.length > 0) {
      jobObj.rules = job.rules.map(rule => {
        const ruleObj: Record<string, unknown> = {};
        if (rule.if) ruleObj.if = rule.if;
        if (rule.when) ruleObj.when = rule.when;
        if (rule.allowFailure) ruleObj.allow_failure = true;
        if (rule.changes) ruleObj.changes = rule.changes;
        if (rule.variables) ruleObj.variables = rule.variables;
        return ruleObj;
      });
    }

    // coverage (from @job coverage)
    if (job.coverage) {
      jobObj.coverage = job.coverage;
    }

    // environment
    if (job.environment) {
      const envConfig = ast.options?.cicd?.environments?.find((e) => e.name === job.environment);
      const envObj: Record<string, unknown> = { name: job.environment };
      if (envConfig?.url) envObj.url = envConfig.url;
      if (envConfig?.reviewers) envObj.deployment_tier = 'production';
      jobObj.environment = envObj;
      if (envConfig?.reviewers) {
        jobObj.when = 'manual';
      }
    }

    // services
    if (job.services && job.services.length > 0) {
      jobObj.services = job.services.map((svc) => {
        const svcObj: Record<string, unknown> = { name: svc.image };
        return svcObj;
      });
    }

    // variables (merge secrets + job-level variables)
    const variables: Record<string, string> = {};
    if (job.secrets.length > 0) {
      for (const secret of job.secrets) {
        variables[secret] = `$${secret}`;
      }
    }
    if (job.variables) {
      Object.assign(variables, job.variables);
    }
    if (Object.keys(variables).length > 0) {
      jobObj.variables = variables;
    }

    // before_script (from @job or @before_script)
    if (job.beforeScript && job.beforeScript.length > 0) {
      jobObj.before_script = job.beforeScript;
    }

    // cache
    if (job.cache) {
      jobObj.cache = this.renderCache(job.cache);
    }

    // artifacts: cross-job data flow via .fw-outputs/ + user-defined artifacts
    const artifactsObj: Record<string, unknown> = {};
    const artifactPaths: string[] = [];

    // Add .fw-outputs/ path for cross-job data flow if downstream jobs exist
    if (job.uploadArtifacts && job.uploadArtifacts.length > 0) {
      artifactPaths.push('.fw-outputs/');
    }

    if (job.uploadArtifacts && job.uploadArtifacts.length > 0) {
      for (const a of job.uploadArtifacts) {
        artifactPaths.push(a.path);
      }
      const expiry = job.uploadArtifacts[0].retention
        ? `${job.uploadArtifacts[0].retention} days`
        : '1 week';
      artifactsObj.expire_in = expiry;
    }
    if (artifactPaths.length > 0) {
      artifactsObj.paths = artifactPaths;
    }
    if (job.reports && job.reports.length > 0) {
      const reports: Record<string, string> = {};
      for (const report of job.reports) {
        reports[report.type] = report.path;
      }
      artifactsObj.reports = reports;
    }
    if (Object.keys(artifactsObj).length > 0) {
      jobObj.artifacts = artifactsObj;
    }

    // script: install deps, then run compiled workflow for this job
    const script: string[] = [];

    if (job.downloadArtifacts && job.downloadArtifacts.length > 0) {
      script.push(`# Artifacts from: ${job.downloadArtifacts.join(', ')} (downloaded automatically via needs:)`);
    }

    // Install dependencies
    script.push('npm ci');

    // Run compiled workflow for this job
    const workflowBasename = ast.functionName;
    script.push(`node dist/${workflowBasename}.cicd.js --job=${job.id}`);

    // Merge step-level env vars (from secret wiring) into the variables block
    for (const step of job.steps) {
      if (step.env) {
        for (const [key, value] of Object.entries(step.env)) {
          variables[key] = value;
        }
      }
    }
    // Re-set variables if step env vars were added
    if (Object.keys(variables).length > 0) {
      jobObj.variables = variables;
    }

    jobObj.script = script;

    return jobObj;
  }

  private renderCache(cache: { strategy: string; key?: string; path?: string }): Record<string, unknown> {
    const cacheObj: Record<string, unknown> = {};

    switch (cache.strategy) {
      case 'npm':
        cacheObj.key = {
          files: [cache.key || 'package-lock.json'],
        };
        cacheObj.paths = [cache.path || 'node_modules/'];
        break;
      case 'pip':
        cacheObj.key = {
          files: [cache.key || 'requirements.txt'],
        };
        cacheObj.paths = [cache.path || '.pip-cache/'];
        break;
      default:
        cacheObj.key = cache.key || '$CI_COMMIT_REF_SLUG';
        cacheObj.paths = [cache.path || '.cache/'];
    }

    return cacheObj;
  }

  /**
   * Apply workflow-level options to jobs.
   */
  private applyWorkflowOptions(jobs: CICDJob[], ast: TWorkflowAST): void {
    const cicd = ast.options?.cicd;
    if (!cicd) return;

    // Apply cache to all jobs
    if (cicd.caches && cicd.caches.length > 0) {
      for (const job of jobs) {
        if (!job.cache) {
          job.cache = cicd.caches[0];
        }
      }
    }

    // Apply services to all jobs
    if (cicd.services && cicd.services.length > 0) {
      for (const job of jobs) {
        if (!job.services) {
          job.services = cicd.services;
        }
      }
    }

    // Apply matrix (GitLab uses `parallel: matrix:`)
    if (cicd.matrix) {
      const rootJobs = jobs.filter((j) => j.needs.length === 0);
      for (const job of rootJobs) {
        job.matrix = cicd.matrix;
      }
    }
  }
}

export default GitLabCITarget;
