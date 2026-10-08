import React, {useState} from 'react';
import {Files, FileText} from 'lucide-react';

export function SuperhumanSelectionIcon({
  iconUrl,
  page,
}: {
  readonly iconUrl?: string;
  readonly page: boolean;
}): React.ReactElement {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span className="integration-link-chip-icon" aria-hidden="true">
      {iconUrl && iconUrl !== failedUrl ? (
        <img
          src={iconUrl}
          alt=""
          width={20}
          height={20}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(iconUrl)}
        />
      ) : page ? (
        <FileText size={16} />
      ) : (
        <Files size={16} />
      )}
    </span>
  );
}
