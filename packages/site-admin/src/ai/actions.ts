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

export type SiteAdminAiProps = Record<string, StandardSchemaV1>
type SchemaInput<Schema> = Schema extends StandardSchemaV1 ? StandardSchemaV1.InferInput<Schema> : never
type SchemaOutput<Schema> = Schema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<Schema> : never
type PropsFrom<Fields extends SiteAdminAiProps, Mode extends 'input' | 'output'> = {
    [Key in keyof Fields]: Mode extends 'input' ? SchemaInput<Fields[Key]> : SchemaOutput<Fields[Key]>
}
type OptionalProps<Props> = { [Key in keyof Props as undefined extends Props[Key] ? never : Key]: Props[Key] } & {
    [Key in keyof Props as undefined extends Props[Key] ? Key : never]?: Props[Key]
}
export type SiteAdminAiActionProps<Fields extends SiteAdminAiProps> = OptionalProps<PropsFrom<Fields, 'input'>>
export type SiteAdminAiValidatedProps<Fields extends SiteAdminAiProps> = OptionalProps<PropsFrom<Fields, 'output'>>
export type SiteAdminDecisionModel =
    | Exclude<Experimental_DecisionModel, string>
    | ((
          context: SiteAdminAIModelContext,
      ) => Exclude<Experimental_DecisionModel, string> | Promise<Exclude<Experimental_DecisionModel, string>>)
type Questions = Record<string, Experimental_DecisionQuestion>
type TextOptions = Omit<Parameters<typeof generateText>[0], 'model' | 'prompt' | 'messages' | 'output'>
type DecisionOptions = Omit<Parameters<typeof experimental_decide>[0], 'model' | 'state' | 'questions'>
type DecisionState = Parameters<typeof experimental_decide>[0]['state']

export type SiteAdminNamedAiAction<Props extends SiteAdminAiProps = SiteAdminAiProps> =
    | {
          type: 'text-generation'
          model?: SiteAdminAIModel
          props: Props
          prompt: {
              run(props: SiteAdminAiValidatedProps<Props>, context: SiteAdminAIModelContext): string | Promise<string>
          }['run']
          output?:
              | Output.Output
              | {
                    run(
                        props: SiteAdminAiValidatedProps<Props>,
                        context: SiteAdminAIModelContext,
                    ): Output.Output | Promise<Output.Output>
                }['run']
          options?: TextOptions
      }
    | {
          type: 'decision'
          model?: SiteAdminDecisionModel
          props: Props
          state: {
              run(
                  props: SiteAdminAiValidatedProps<Props>,
                  context: SiteAdminAIModelContext,
              ): DecisionState | Promise<DecisionState>
          }['run']
          questions: Questions
          options?: DecisionOptions
      }

export type SiteAdminAiActionsFromProps<Props extends Record<string, SiteAdminAiProps>> = {
    [Name in keyof Props]: SiteAdminNamedAiAction<Props[Name]>
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
              props: Actions[Name] extends { props: infer Props extends SiteAdminAiProps }
                  ? SiteAdminAiActionProps<Props>
                  : never
              data: SiteAdminAiActionData<Actions[Name]>
          }
      }
    : {}
