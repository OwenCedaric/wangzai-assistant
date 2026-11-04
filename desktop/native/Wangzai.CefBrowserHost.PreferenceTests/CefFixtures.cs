namespace CefSharp
{
    public interface IRequestContext
    {
        bool SetPreference(string name, object value, out string error);
        object GetPreference(string name);
    }
    public static class Cef { public static TaskFactory UIThreadTaskFactory { get; } = new(TaskScheduler.Default); }
}
namespace CefSharp.Handler
{
    public class RequestContextHandler
    {
        public void InitializeFixture(CefSharp.IRequestContext context) => OnRequestContextInitialized(context);
        protected virtual void OnRequestContextInitialized(CefSharp.IRequestContext context) { }
    }
}
