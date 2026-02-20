export async function runModelAction(input: {
  channelId: string;
  model: string;
  setSessionModel: (channelId: string, model: string) => void;
  stopControllerSetModel: (channelId: string, model: string) => Promise<unknown>;
}): Promise<{ message: string }> {
  input.setSessionModel(input.channelId, input.model);
  await input.stopControllerSetModel(input.channelId, input.model);
  return { message: `Model set to \`${input.model}\`.` };
}
