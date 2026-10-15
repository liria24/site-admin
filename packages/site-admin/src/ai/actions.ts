import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
    Experimental_DecisionModel,
    Experimental_DecisionQuestion,
    Experimental_DecisionResult,
    Output,
    experimental_decide,
    generateText,
} from 'ai'
import type { SiteAdminAIModel, SiteAdminAIModelContext } from '../ai'

export type SiteAdminAiInput = StandardSchemaV1
export type SiteAdminAiActionInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>
type ValidatedInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>
export type SiteAdminDecisionModel =
    | Exclude<Experimental_DecisionModel, string>
    | ((
          context: SiteAdminAIModelContext,
      ) => Exclude<Experimental_DecisionModel, string> | Promise<Exclude<Experimental_DecisionModel, string>>)
type Questions = Record<string, Experimental_DecisionQuestion>
type TextOptions = Omit<Parameters<typeof generateText>[0], 'model' | 'prompt' | 'messages' | 'output'>
type DecisionOptions = Omit<Parameters<typeof experimental_decide>[0], 'model' | 'state' | 'questions'>
type DecisionState = Parameters<typeof experimental_decide>[0]['state']

export type SiteAdminNamedAiAction<Input extends SiteAdminAiInput = SiteAdminAiInput> =
    | {
          type: 'text-generation'
          model?: SiteAdminAIModel
          input: Input
          prompt: {
              run(input: ValidatedInput<Input>, context: SiteAdminAIModelContext): string | Promise<string>
          }['run']
          output?:
              | Output.Output
              | {
                    run(
                        input: ValidatedInput<Input>,
                        context: SiteAdminAIModelContext,
                    ): Output.Output | Promise<Output.Output>
                }['run']
          options?: TextOptions
      }
    | {
          type: 'decision'
          model?: SiteAdminDecisionModel
          input: Input
          state: {
              run(
                  input: ValidatedInput<Input>,
                  context: SiteAdminAIModelContext,
              ): DecisionState | Promise<DecisionState>
          }['run']
          questions: Questions
          options?: DecisionOptions
      }

export type SiteAdminAiActionsFromInput<Input extends Record<string, SiteAdminAiInput>> = {
    [Name in keyof Input]: SiteAdminNamedAiAction<Input[Name]>
}
export type SiteAdminAiActionData<Action> = Action extends { type: 'text-generation' }
    ? Action extends { output: infer Spec }
        ? (Spec extends (...args: never[]) => unknown ? Awaited<ReturnType<Spec>> : Spec) extends Output.Output<
              infer Complete
          >
            ? Complete
            : never
        : string
    : Action extends { type: 'decision'; questions: infer TypedQuestions extends Questions }
      ? Experimental_DecisionResult<TypedQuestions>['answers']
      : never
export type InferSiteAdminNamedAiActions<Config> = Config extends { ai: { actions: infer Actions } }
    ? {
          [Name in keyof Actions]: {
              input: Actions[Name] extends { input: infer Input extends SiteAdminAiInput }
                  ? SiteAdminAiActionInput<Input>
                  : never
              data: SiteAdminAiActionData<Actions[Name]>
          }
      }
    : {}
