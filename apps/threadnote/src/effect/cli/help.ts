import {Context, Option} from 'effect';
import {CliOutput, Command, type HelpDoc} from 'effect/cli';

class DefaultActionSubcommand extends Context.Service<DefaultActionSubcommand, true>()(
  '@threadnote/threadnote/effect/cli/help/DefaultActionSubcommand',
) {}

export function optionalSubcommandHelpDoc(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  return Option.isSome(Context.getOption(doc.annotations, DefaultActionSubcommand))
    ? {...doc, usage: doc.usage.replace(' <subcommand>', ' [<subcommand>]')}
    : doc;
}

const defaultFormatter = CliOutput.defaultFormatter();

export const threadnoteCliFormatter = {
  ...defaultFormatter,
  formatHelpDoc: (doc: HelpDoc.HelpDoc) => defaultFormatter.formatHelpDoc(optionalSubcommandHelpDoc(doc)),
};

export const threadnoteCliFormatterLayer = CliOutput.layer(threadnoteCliFormatter);

export const withDefaultActionSubcommand = Command.annotate(DefaultActionSubcommand, true);
