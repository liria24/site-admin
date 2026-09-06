export interface SiteAdminAIAction<Input, Output> {
    name: string
    run: (input: Input) => Promise<Output> | Output
}

export const defineSiteAdminAIAction = <Input, Output>(
    action: SiteAdminAIAction<Input, Output>,
): SiteAdminAIAction<Input, Output> => action

export const runSiteAdminAIAction = async <Input, Output>(
    action: SiteAdminAIAction<Input, Output>,
    input: Input,
): Promise<Output> => action.run(input)
