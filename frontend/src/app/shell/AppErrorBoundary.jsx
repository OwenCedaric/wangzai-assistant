import React from 'react';

export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    void globalThis.wangzaiDesktop?.uiUpdates?.failed?.().catch(() => undefined);
    const detail = error?.stack || error?.message || String(error);
    console.error(`[app-error-boundary] ${detail}\n${info?.componentStack || ''}`);
  }

  reloadPage = () => {
    globalThis.location?.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error-fallback">
          <strong>页面显示异常</strong>
          <span>请刷新页面重试，或检查最近读取的数据。</span>
          <button type="button" className="app-error-reload-button" onClick={this.reloadPage}>
            重新加载页面
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
