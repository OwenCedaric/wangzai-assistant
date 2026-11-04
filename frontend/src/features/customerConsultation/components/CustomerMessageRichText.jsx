import { parseCustomerMessageLinks } from '../lib/customerMessageLinkParser.js';
import { openInternalBrowserLinkFromEvent } from '../../../services/internalBrowserLinkClient.js';
import Typography from '@mui/material/Typography';
import React from 'react';

export const CustomerMessageRichText = React.memo(function CustomerMessageRichText({
  text = '',
  component = 'div',
  className = '',
  ...typographyProps
}) {
  const tokens = React.useMemo(() => parseCustomerMessageLinks(text), [text]);

  return (
    <Typography component={component} className={className} {...typographyProps}>
      {tokens.map((token, index) =>
        token.type === 'link' ? (
          <a
            key={`${token.href}-${index}`}
            className="customer-message-link"
            href={token.href}
            onClick={(event) => {
              void openInternalBrowserLinkFromEvent(event, token.href).catch(() => undefined);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {token.text}
          </a>
        ) : (
          <React.Fragment key={`text-${index}`}>{token.text}</React.Fragment>
        )
      )}
    </Typography>
  );
});
