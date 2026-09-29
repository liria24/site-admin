// The binding-only probe must never load files-sdk's optional HTTP signing engine.
export const unused = true
throw new Error('The R2 binding test attempted to use the AWS HTTP engine.')
