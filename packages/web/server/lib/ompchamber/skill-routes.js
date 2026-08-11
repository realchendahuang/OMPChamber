import { buildDeferredRestartResponse } from './config-mutation-response.js';

/**
 * Matches how OpenCode reads its own boolean env flags: any value other than
 * unset, empty, "0" or "false" enables the flag.
 */
const isEnvFlagEnabled = (value) => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '0' && normalized !== 'false';
};

export const registerSkillRoutes = (app, dependencies) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    readSettingsFromDisk,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    getSkillSources,
    discoverSkills,
    mergeDiscoveredSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    renameSkill,
    isManagedSkillPath,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources,
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    scanClawdHubPage,
    installSkillsFromClawdHub,
    isClawdHubSource,
    getProfiles,
    getProfile,
  } = dependencies;

  // OpenCode-shaped discovered skills come from the upstream OpenCode server.
  // The OMP engine is the only engine (there is no OpenCode process), so this
  // surface is intentionally empty: the UI renders the curated catalog and
  // user/workspace skills without an upstream discovery merge.
  const fetchOpenCodeDiscoveredSkills = async () => [];

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };

  const resolveGitIdentity = (profileId) => {
    if (!profileId) {
      return null;
    }
    try {
      const profile = getProfile(profileId);
      const sshKey = profile?.sshKey;
      if (typeof sshKey === 'string' && sshKey.trim()) {
        return { sshKey: sshKey.trim() };
      }
    } catch {
      // ignore
    }
    return null;
  };

  // Prefer an explicit request directory, then soft-fallback to the active
  // project / lastDirectory so repository-local skills stay visible when the
  // client omits `directory` (create already used resolveProjectDirectory).
  const resolveSkillsDirectory = async (req) => {
    const optional = await resolveOptionalProjectDirectory(req);
    if (optional.error) {
      return optional;
    }
    if (optional.directory) {
      return optional;
    }

    try {
      const fallback = await resolveProjectDirectory(req);
      if (fallback.directory) {
        return { directory: fallback.directory, error: null };
      }
    } catch {
      // ignore — listing user-scoped skills without a project is valid
    }

    return { directory: null, error: null };
  };

  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const openCodeSkills = await fetchOpenCodeDiscoveredSkills(directory);
      const localSkills = discoverSkills(directory);
      const skills = mergeDiscoveredSkills(openCodeSkills, localSkills);

      const enrichedSkills = skills.map((skill) => {
        const sources = getSkillSources(skill.name, directory, skill);
        const skillPath = typeof skill.path === 'string' ? skill.path : null;
        return {
          ...skill,
          sources,
          renamable: Boolean(
            skillPath
            && skillPath !== '<built-in>'
            && isManagedSkillPath(skillPath, directory)
          ),
        };
      });

      // OpenCode decides which external skill roots it loads from process
      // env, and the browser cannot read that. Report the flags alongside the
      // scan so the client can narrow its list to what the agent can actually
      // invoke.
      //
      // OpenCode's own skill-list endpoint is not usable for this: on 1.18.14
      // it returns only global and builtin skills, omitting the project
      // `.agents`/`.claude` skills the agent demonstrably has.
      res.json({
        skills: enrichedSkills,
        externalSkills: {
          // `OPENCODE_DISABLE_CLAUDE_CODE` is the broad switch; the specific
          // one wins independently — OpenCode ORs them.
          claudeDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE)
            || isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
          allDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS),
        },
      });
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const sourcesForUi = sources.map(({ gitIdentityId, ...rest }) => rest);

      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {}, pageInfoBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
      }

      const resolvedDiscovered = mergeDiscoveredSkills(
        await fetchOpenCodeDiscoveredSkills(directory),
        discoverSkills(directory),
      );
      const installedByName = new Map(resolvedDiscovered.map((s) => [s.name, s]));

      if (src.sourceType === 'clawdhub' || isClawdHubSource(src.source)) {
        const scanned = await scanClawdHubPage({ cursor: cursor || null });
        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        const items = (scanned.items || []).map((item) => {
          const installed = installedByName.get(item.skillName);
          return {
            ...item,
            sourceId: src.id,
            installed: installed
              ? { isInstalled: true, scope: installed.scope, source: installed.source }
              : { isInstalled: false },
          };
        });

        return res.json({ ok: true, items, nextCursor: scanned.nextCursor || null });
      }

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });

      let scanResult = !refresh ? getCachedScan(cacheKey) : null;
      if (!scanResult) {
        const scanned = await scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolveGitIdentity(src.gitIdentityId),
        });

        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        scanResult = scanned;
        setCachedScan(cacheKey, scanResult);
      }

      const items = (scanResult.items || []).map((item) => {
        const installed = installedByName.get(item.skillName);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: installed
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({
        ok: false,
        error: { kind: 'unknown', message: error.message || 'Failed to load catalog source' },
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await scanSkillsRepository({
        source,
        subpath,
        identity,
      });

      if (!result.ok) {
        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = req.body || {};

      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          });
        }
        workingDirectory = resolved.directory;
      }

      if (isClawdHubSource(source)) {
        const result = await installSkillsFromClawdHub({
          scope,
          targetSource,
          workingDirectory,
          userSkillDir: SKILL_DIR,
          selections,
          conflictPolicy,
          conflictDecisions,
        });

        if (!result.ok) {
          if (result.error?.kind === 'conflicts') {
            return res.status(409).json({ ok: false, error: result.error });
          }
          return res.status(400).json({ ok: false, error: result.error });
        }

        const installed = result.installed || [];
        const skipped = result.skipped || [];
        const requiresRestart = installed.length > 0;

        return res.json({
          ok: true,
          installed,
          skipped,
          ...(requiresRestart
            ? buildDeferredRestartResponse('Skills installed successfully. Restart OpenCode to apply.')
            : {
              requiresReload: false,
              message: 'No skills were installed',
            }),
        });
      }

      const identity = resolveGitIdentity(gitIdentityId);

      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity,
        scope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections,
        conflictPolicy,
        conflictDecisions,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') {
          return res.status(409).json({ ok: false, error: result.error });
        }

        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const requiresRestart = installed.length > 0;

      res.json({
        ok: true,
        installed,
        skipped,
        ...(requiresRestart
          ? buildDeferredRestartResponse('Skills installed successfully. Restart OpenCode to apply.')
          : {
            requiresReload: false,
            message: 'No skills were installed',
          }),
      });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to install skills' } });
    }
  });

  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const discoveredSkill = (await fetchOpenCodeDiscoveredSkills(directory))
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);

      res.json({
        name: skillName,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = (await fetchOpenCodeDiscoveredSkills(directory))
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = scope === SKILL_SCOPE.PROJECT
        ? await resolveProjectDirectory(req)
        : await resolveSkillsDirectory(req);
      if (error || (scope === SKILL_SCOPE.PROJECT && !directory)) {
        return res.status(400).json({ error: error || 'Project skill creation requires a directory' });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createSkill(skillName, { ...config, source: skillSource }, directory, scope);
      res.json(buildDeferredRestartResponse(
        `Skill ${skillName} created successfully. Restart OpenCode to apply.`,
      ));
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      if (typeof updates?.renameTo === 'string') {
        const newName = updates.renameTo.trim();
        console.log(`[Server] Renaming skill: ${skillName} -> ${newName}`);
        console.log('[Server] Working directory:', directory);
        renameSkill(skillName, newName, directory);
        await refreshOpenCodeAfterConfigChange('skill rename');

        return res.json({
          success: true,
          name: newName,
          requiresReload: true,
          message: `Skill renamed to ${newName} successfully. Reloading interface…`,
          reloadDelayMs: clientReloadDelayMs,
        });
      }

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      updateSkill(skillName, updates, directory, updates?.targetPath);
      res.json(buildDeferredRestartResponse(
        `Skill ${skillName} updated successfully. Restart OpenCode to apply.`,
      ));
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      res.status(500).json({ error: error.message || 'Failed to update skill' });
    }
  });

  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { content } = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = (await fetchOpenCodeDiscoveredSkills(directory))
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath);
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = (await fetchOpenCodeDiscoveredSkills(directory))
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      deleteSkill(skillName, directory);
      res.json(buildDeferredRestartResponse(
        `Skill ${skillName} deleted successfully. Restart OpenCode to apply.`,
      ));
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill' });
    }
  });
};
