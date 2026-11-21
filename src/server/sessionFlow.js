// Authentication must restore the flow saved with an existing assignment.
export function selectSessionFlow(userdata, configuredFlow) {
  const saved = userdata?.sessionFlow;
  if (Array.isArray(saved?.stages) && saved.stages.length) return saved;
  if (userdata?.state?.stageIndex != null || userdata?.state?.tasks?.length) {
    throw new Error('Assigned challenge has no valid persisted session flow');
  }
  return configuredFlow;
}
