using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace Wangzai.CefBrowserHost;

internal sealed class PurchaseOrderWorkbenchPanel : Panel
{
	private const int SidebarWidth = 600;
	private const int SidebarMinimumWidth = 560;
	private const int CardHorizontalPadding = 18;
	private static readonly Color PageBackground = Color.FromArgb(247, 248, 250);
	private static readonly Color Paper = Color.White;
	private static readonly Color TextPrimary = Color.FromArgb(39, 54, 75);
	private static readonly Color TextSecondary = Color.FromArgb(102, 112, 133);
	private static readonly Color Divider = Color.FromArgb(217, 222, 231);
	private static readonly Color SoftDivider = Color.FromArgb(237, 240, 243);
	private static readonly Color Primary = Color.FromArgb(93, 135, 255);
	private static readonly Color PrimaryLight = Color.FromArgb(236, 242, 255);
	private static readonly Color Success = Color.FromArgb(19, 222, 185);
	private static readonly Color SuccessLight = Color.FromArgb(230, 255, 250);
	private static readonly Color Warning = Color.FromArgb(255, 174, 31);
	private static readonly Color WarningLight = Color.FromArgb(254, 245, 229);
	private static readonly Color Error = Color.FromArgb(250, 137, 107);
	private static readonly Color ErrorLight = Color.FromArgb(253, 237, 232);

	private readonly ToolTip toolTip = new()
	{
		AutoPopDelay = 12000,
		InitialDelay = 350,
		ReshowDelay = 100,
		ShowAlways = true,
	};

	private readonly FlowLayoutPanel content = new()
	{
		Dock = DockStyle.Fill,
		AutoScroll = true,
		FlowDirection = FlowDirection.TopDown,
		WrapContents = false,
		Padding = new Padding(20, 18, 20, 22),
		BackColor = PageBackground,
	};

	public bool HasContent { get; private set; }

	public string HeaderTitle { get; private set; } = "订单操作台";

	public PurchaseOrderWorkbenchPanel()
	{
		Dock = DockStyle.Left;
		Width = SidebarWidth;
		MinimumSize = new Size(SidebarMinimumWidth, 0);
		BackColor = Divider;
		Padding = new Padding(0, 0, 1, 0);
		Visible = false;
		Controls.Add(content);
		content.SizeChanged += delegate { UpdateChildWidths(); };
	}

	public void Apply(JsonObject? payload)
	{
		string kind = FieldText(payload, "kind", string.Empty);
		HasContent = payload != null && kind == "purchase-order";
		HeaderTitle = FieldText(payload, "title", "订单操作台");
		DisposeChildren();
		Visible = HasContent;
		if (!HasContent || payload == null) return;

		JsonObject order = Object(payload, "order");
		JsonObject product = Object(payload, "product");
		JsonObject source = Object(payload, "source");
		JsonObject logistics = Object(payload, "logistics");
		string platform = FieldText(source, "platform",
			FieldText(order, "purchasePlatform", "待补录"));

		content.SuspendLayout();
		try
		{
			content.Controls.Add(HeaderCard(
				HeaderTitle,
				FieldText(order, "orderNo", "暂无订单"),
				FieldText(order, "status"),
				platform));
			content.Controls.Add(Card("订单信息", new[]
			{
				Item("货号", FieldText(order, "goodsNo")),
				Item("Ozon ID", FieldText(order, "ozonOrderId")),
				Item("店铺", FieldText(order, "shop")),
				Item("销售金额", FieldText(order, "salesAmount")),
				Item("采购平台", FieldText(order, "purchasePlatform")),
				Item("采购单号", FieldText(order, "purchaseOrderNo")),
				Item("Ozon 状态", FieldText(order, "ozonStatus")),
				Item("付款时间", FieldText(order, "paymentTime")),
			}));
			content.Controls.Add(Card("商品与货源", new[]
			{
				Item("商品", FieldText(product, "title", "暂无商品信息")),
				Item("SKU", FieldText(product, "sku")),
				Item("数量", FieldText(product, "quantity", "x1")),
				Item("货源平台", platform),
				Item("货源成本", FieldText(source, "amount", "待确认")),
				Item("当前链接", FieldText(source, "url"), accent: true),
			}));
			content.Controls.Add(Card("物流包裹", new[]
			{
				Item("order_id", FieldText(logistics, "orderId")),
				Item("包裹重量", FieldText(logistics, "weight")),
				Item("材积尺寸", FieldText(logistics, "size")),
				Item("物流路线", FieldText(logistics, "route", "路线待确认")),
				Item("读取状态", FieldText(logistics, "readStatus")),
			}));

			ProfitItem[] profits = ProfitRows(payload).ToArray();
			if (profits.Length > 0) content.Controls.Add(ProfitCard(profits));
			content.Controls.Add(Notice(FieldText(
				payload,
				"notice",
				"左侧订单信息固定，右侧网页可以自由操作。")));
		}
		finally
		{
			content.ResumeLayout(performLayout: true);
			UpdateChildWidths();
		}
	}

	private static InfoItem Item(string label, string value, bool accent = false) => new(label, value, accent);

	private static IEnumerable<ProfitItem> ProfitRows(JsonObject payload)
	{
		if (payload["profitItems"] is not JsonArray items) yield break;
		foreach (JsonObject item in items.OfType<JsonObject>().Take(5))
		{
			string label = FieldText(item, "label", string.Empty);
			if (label.Length == 0) continue;
			yield return new ProfitItem(
				label,
				FieldText(item, "value", "待确认"),
				FieldText(item, "tone", string.Empty));
		}
	}

	private Control HeaderCard(string title, string orderNo, string status, string platform)
	{
		RoundedPanel card = CreatePaper(172);
		Label heading = CreateLabel(title, 14f, TextPrimary, FontStyle.Bold);
		heading.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
		card.Controls.Add(heading);

		FlowLayoutPanel badges = new()
		{
			AutoSize = true,
			AutoSizeMode = AutoSizeMode.GrowAndShrink,
			FlowDirection = FlowDirection.LeftToRight,
			WrapContents = false,
			BackColor = Color.Transparent,
		};
		badges.Controls.Add(Badge(platform, PlatformColors(platform)));
		badges.Controls.Add(Badge(status, StatusColors(status)));
		card.Controls.Add(badges);

		Label caption = CreateLabel("订单号", 9f, TextSecondary);
		card.Controls.Add(caption);

		Label value = CreateValueLabel(orderNo, 11f, FontStyle.Bold);
		value.Text = WrapLongTokens(orderNo);
		value.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
		value.AutoEllipsis = false;
		value.UseCompatibleTextRendering = true;
		card.Controls.Add(value);
		toolTip.SetToolTip(value, orderNo);
		bool arranging = false;
		void Arrange()
		{
			if (arranging) return;
			arranging = true;
			int width = Math.Max(180, card.ClientSize.Width - (CardHorizontalPadding * 2));
			heading.Location = new Point(CardHorizontalPadding, 16);
			heading.Size = new Size(width, TextLineHeight(heading.Font, 6));
			badges.Location = new Point(CardHorizontalPadding - 6, heading.Bottom + 8);
			caption.Location = new Point(CardHorizontalPadding, badges.Bottom + 14);
			caption.Size = new Size(width, TextLineHeight(caption.Font, 3));
			value.Location = new Point(CardHorizontalPadding, caption.Bottom + 4);
			int valueHeight = WrappedTextHeight(
				value.Text,
				value.Font,
				width,
				TextLineHeight(value.Font, 6));
			value.Size = new Size(width, valueHeight);
			card.Height = value.Bottom + 18;
			arranging = false;
		}
		card.SizeChanged += delegate { Arrange(); };
		Arrange();
		return card;
	}

	private Control Card(string title, IReadOnlyList<InfoItem> items)
	{
		RoundedPanel card = CreatePaper(120);
		Label heading = CreateLabel(title, 11.5f, TextPrimary, FontStyle.Bold);
		heading.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
		card.Controls.Add(heading);

		Panel divider = new()
		{
			BackColor = SoftDivider,
			Height = 1,
			Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
		};
		card.Controls.Add(divider);

		List<FieldControls> fields = new();
		for (int index = 0; index < items.Count; index += 1)
		{
			InfoItem item = items[index];
			Label caption = CreateLabel(item.Label, 9f, TextSecondary);
			Label value = CreateValueLabel(
				item.Value,
				10.5f,
				FontStyle.Bold,
				item.Accent ? Primary : null);
			value.Text = WrapLongTokens(item.Value);
			value.AutoEllipsis = false;
			value.UseCompatibleTextRendering = true;
			Panel? separator = index < items.Count - 1
				? new Panel { BackColor = SoftDivider, Height = 1 }
				: null;
			card.Controls.Add(caption);
			card.Controls.Add(value);
			if (separator != null) card.Controls.Add(separator);
			toolTip.SetToolTip(value, item.Value);
			fields.Add(new FieldControls(caption, value, separator));
		}

		bool arranging = false;
		void Arrange()
		{
			if (arranging) return;
			arranging = true;
			int width = Math.Max(180, card.ClientSize.Width - (CardHorizontalPadding * 2));
			heading.Location = new Point(CardHorizontalPadding, 14);
			heading.Size = new Size(width, TextLineHeight(heading.Font, 5));
			divider.Location = new Point(CardHorizontalPadding, heading.Bottom + 9);
			divider.Width = width;
			int top = divider.Bottom + 11;
			foreach (FieldControls field in fields)
			{
				field.Caption.Location = new Point(CardHorizontalPadding, top);
				field.Caption.Size = new Size(width, TextLineHeight(field.Caption.Font, 3));
				top = field.Caption.Bottom + 4;
				int valueHeight = WrappedTextHeight(
					field.Value.Text,
					field.Value.Font,
					width,
					TextLineHeight(field.Value.Font, 5));
				field.Value.Location = new Point(CardHorizontalPadding, top);
				field.Value.Size = new Size(width, valueHeight);
				top += valueHeight + 11;
				if (field.Separator != null)
				{
					field.Separator.Location = new Point(CardHorizontalPadding, top);
					field.Separator.Width = width;
					top += 12;
				}
			}
			card.Height = top + 5;
			arranging = false;
		}
		card.SizeChanged += delegate { Arrange(); };
		Arrange();
		return card;
	}

	private Control ProfitCard(IReadOnlyList<ProfitItem> items)
	{
		RoundedPanel card = CreatePaper(120, Color.FromArgb(255, 252, 245), Color.FromArgb(240, 221, 170));
		Label heading = CreateLabel("费用与利润", 11.5f, TextPrimary, FontStyle.Bold);
		heading.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
		card.Controls.Add(heading);

		Panel headerDivider = new()
		{
			BackColor = Color.FromArgb(242, 229, 198),
			Height = 1,
			Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
		};
		card.Controls.Add(headerDivider);

		List<ProfitControls> rows = new();
		for (int index = 0; index < items.Count; index += 1)
		{
			ProfitItem item = items[index];
			Label caption = CreateLabel(item.Label, 9.5f, TextSecondary, FontStyle.Bold);
			caption.TextAlign = ContentAlignment.MiddleLeft;
			Label value = CreateValueLabel(item.Value, 9.75f, FontStyle.Bold, ProfitColor(item.Tone));
			value.TextAlign = ContentAlignment.MiddleRight;
			value.AutoEllipsis = false;
			Panel? separator = index < items.Count - 1
				? new Panel { BackColor = Color.FromArgb(246, 236, 212), Height = 1 }
				: null;
			card.Controls.Add(caption);
			card.Controls.Add(value);
			if (separator != null) card.Controls.Add(separator);
			toolTip.SetToolTip(value, item.Value);
			rows.Add(new ProfitControls(caption, value, separator));
		}

		bool arranging = false;
		void Arrange()
		{
			if (arranging) return;
			arranging = true;
			int width = Math.Max(180, card.ClientSize.Width - (CardHorizontalPadding * 2));
			int captionWidth = Math.Max(100, (int)(width * 0.48));
			heading.Location = new Point(CardHorizontalPadding, 14);
			heading.Size = new Size(width, TextLineHeight(heading.Font, 5));
			headerDivider.Location = new Point(CardHorizontalPadding, heading.Bottom + 9);
			headerDivider.Width = width;
			int top = headerDivider.Bottom + 8;
			foreach (ProfitControls row in rows)
			{
				int rowHeight = Math.Max(
					TextLineHeight(row.Caption.Font, 7),
					TextLineHeight(row.Value.Font, 7));
				row.Caption.Location = new Point(CardHorizontalPadding, top);
				row.Caption.Size = new Size(captionWidth, rowHeight);
				row.Value.Location = new Point(CardHorizontalPadding + captionWidth, top);
				row.Value.Size = new Size(width - captionWidth, rowHeight);
				top += rowHeight + 5;
				if (row.Separator != null)
				{
					row.Separator.Location = new Point(CardHorizontalPadding, top);
					row.Separator.Width = width;
					top += 7;
				}
			}
			card.Height = top + 9;
			arranging = false;
		}
		card.SizeChanged += delegate { Arrange(); };
		Arrange();
		return card;
	}

	private Control Notice(string message)
	{
		RoundedPanel card = CreatePaper(76, Color.FromArgb(248, 250, 255), Color.FromArgb(219, 226, 240));
		Label label = CreateLabel(message, 9f, Color.FromArgb(81, 103, 142));
		label.Text = WrapLongTokens(message);
		label.AutoEllipsis = false;
		label.UseCompatibleTextRendering = true;
		label.Location = new Point(14, 12);
		label.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
		label.TextAlign = ContentAlignment.MiddleLeft;
		card.Controls.Add(label);
		toolTip.SetToolTip(label, message);
		bool arranging = false;
		void Arrange()
		{
			if (arranging) return;
			arranging = true;
			int width = Math.Max(180, card.ClientSize.Width - 28);
			int height = WrappedTextHeight(label.Text, label.Font, width, 42);
			label.Size = new Size(width, height);
			card.Height = label.Bottom + 12;
			arranging = false;
		}
		card.SizeChanged += delegate { Arrange(); };
		Arrange();
		return card;
	}

	private RoundedPanel CreatePaper(int height, Color? fill = null, Color? border = null)
	{
		return new RoundedPanel
		{
			AutoSize = false,
			Width = 520,
			Height = height,
			FillColor = fill ?? Paper,
			BorderColor = border ?? Divider,
			CornerRadius = 12,
			Margin = new Padding(0, 0, 0, 14),
		};
	}

	private RoundedLabel Badge(string value, (Color Fill, Color Text) colors)
	{
		using Font measurementFont = UiFont(8.5f, FontStyle.Bold);
		int width = Math.Clamp(TextRenderer.MeasureText(value, measurementFont).Width + 18, 58, 128);
		int height = TextLineHeight(measurementFont, 7);
		return new RoundedLabel
		{
			Text = value,
			Size = new Size(width, height),
			FillColor = colors.Fill,
			TextColor = colors.Text,
			CornerRadius = 8,
			Font = UiFont(8.5f, FontStyle.Bold),
			Margin = new Padding(6, 0, 0, 0),
		};
	}

	private static (Color Fill, Color Text) PlatformColors(string value)
	{
		string text = value.ToLowerInvariant();
		if (text.Contains("pdd") || text.Contains("拼多多")) return (ErrorLight, Color.FromArgb(250, 108, 71));
		if (text.Contains("1688")) return (WarningLight, Color.FromArgb(217, 130, 0));
		if (text.Contains("天猫")) return (Color.FromArgb(255, 241, 241), Color.FromArgb(240, 68, 68));
		if (text.Contains("淘宝")) return (PrimaryLight, Color.FromArgb(77, 115, 255));
		if (text.Contains("ozon")) return (PrimaryLight, Color.FromArgb(52, 97, 212));
		return (Color.FromArgb(248, 250, 252), TextSecondary);
	}

	private static (Color Fill, Color Text) StatusColors(string value)
	{
		string text = value.ToLowerInvariant();
		if (text.Contains("完成") || text.Contains("成功") || text.Contains("已拍")) return (SuccessLight, Color.FromArgb(8, 168, 138));
		if (text.Contains("失败") || text.Contains("异常") || text.Contains("取消")) return (ErrorLight, Error);
		if (text.Contains("待") || text.Contains("未")) return (WarningLight, Color.FromArgb(217, 130, 0));
		return (PrimaryLight, Primary);
	}

	private static Color ProfitColor(string tone)
	{
		if (tone.Contains("loss", StringComparison.OrdinalIgnoreCase)) return Success;
		if (tone.Contains("profit", StringComparison.OrdinalIgnoreCase)) return Color.Red;
		return TextPrimary;
	}

	private static int WrappedTextHeight(string value, Font font, int width, int minimumHeight)
	{
		Size measured = TextRenderer.MeasureText(
			value,
			font,
			new Size(Math.Max(1, width), int.MaxValue),
			TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPrefix);
		return Math.Max(minimumHeight, measured.Height + 4);
	}

	private static int TextLineHeight(Font font, int extra = 0)
	{
		return TextRenderer.MeasureText("Ag中", font).Height + extra;
	}

	private static string WrapLongTokens(string value)
	{
		if (string.IsNullOrEmpty(value)) return value;
		StringBuilder builder = new(value.Length + 16);
		int uninterrupted = 0;
		foreach (char character in value)
		{
			builder.Append(character);
			if (char.IsWhiteSpace(character))
			{
				uninterrupted = 0;
				continue;
			}
			uninterrupted += 1;
			if (character is '/' or '?' or '&' or '=' or '_' or '-' or '.' or ':')
			{
				builder.Append('\u200B');
				uninterrupted = 0;
			}
			else if (uninterrupted >= 28)
			{
				builder.Append('\u200B');
				uninterrupted = 0;
			}
		}
		return builder.ToString();
	}

	private static Label CreateLabel(string value, float size, Color color, FontStyle style = FontStyle.Regular)
	{
		return new Label
		{
			Text = value,
			AutoSize = false,
			ForeColor = color,
			BackColor = Color.Transparent,
			Font = UiFont(size, style),
			UseMnemonic = false,
		};
	}

	private static Label CreateValueLabel(string value, float size, FontStyle style, Color? color = null)
	{
		Label label = CreateLabel(value, size, color ?? TextPrimary, style);
		label.AutoEllipsis = false;
		label.TextAlign = ContentAlignment.MiddleLeft;
		return label;
	}

	private static Font UiFont(float size, FontStyle style = FontStyle.Regular)
	{
		return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Point);
	}

	private void DisposeChildren()
	{
		while (content.Controls.Count > 0)
		{
			Control child = content.Controls[0];
			content.Controls.RemoveAt(0);
			child.Dispose();
		}
	}

	private void UpdateChildWidths()
	{
		int reservedScrollWidth = SystemInformation.VerticalScrollBarWidth + 4;
		int width = Math.Max(420, content.ClientSize.Width - content.Padding.Horizontal - reservedScrollWidth);
		foreach (Control child in content.Controls) child.Width = width;
	}

	protected override void Dispose(bool disposing)
	{
		if (disposing) toolTip.Dispose();
		base.Dispose(disposing);
	}

	private static JsonObject Object(JsonObject payload, string name)
	{
		return payload[name] as JsonObject ?? new JsonObject();
	}

	private static string FieldText(JsonObject? payload, string name, string fallback = "未返回")
	{
		string value = payload?[name]?.ToString()?.Trim() ?? string.Empty;
		if (value.Length == 0) return fallback;
		return value;
	}

	private static GraphicsPath RoundedPath(Rectangle bounds, int radius)
	{
		GraphicsPath path = new();
		int diameter = Math.Max(2, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
		Rectangle arc = new(bounds.Location, new Size(diameter, diameter));
		path.AddArc(arc, 180, 90);
		arc.X = bounds.Right - diameter;
		path.AddArc(arc, 270, 90);
		arc.Y = bounds.Bottom - diameter;
		path.AddArc(arc, 0, 90);
		arc.X = bounds.Left;
		path.AddArc(arc, 90, 90);
		path.CloseFigure();
		return path;
	}

	private readonly record struct InfoItem(string Label, string Value, bool Accent);
	private readonly record struct ProfitItem(string Label, string Value, string Tone);
	private readonly record struct FieldControls(Label Caption, Label Value, Panel? Separator);
	private readonly record struct ProfitControls(Label Caption, Label Value, Panel? Separator);

	private sealed class RoundedPanel : Panel
	{
		public Color FillColor { get; init; } = Color.White;
		public Color BorderColor { get; init; } = Color.Transparent;
		public int CornerRadius { get; init; } = 8;

		public RoundedPanel()
		{
			SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
		}

		protected override void OnPaintBackground(PaintEventArgs e)
		{
			e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
			using SolidBrush background = new(Parent?.BackColor ?? PageBackground);
			e.Graphics.FillRectangle(background, ClientRectangle);
			using GraphicsPath path = RoundedPath(new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1)), CornerRadius);
			using SolidBrush brush = new(FillColor);
			e.Graphics.FillPath(brush, path);
		}

		protected override void OnPaint(PaintEventArgs e)
		{
			base.OnPaint(e);
			if (BorderColor.A == 0) return;
			e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
			using GraphicsPath path = RoundedPath(new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1)), CornerRadius);
			using Pen pen = new(BorderColor);
			e.Graphics.DrawPath(pen, path);
		}
	}

	private sealed class RoundedLabel : Control
	{
		public Color FillColor { get; init; } = Color.Transparent;
		public Color TextColor { get; init; } = Color.Black;
		public int CornerRadius { get; init; } = 8;

		public RoundedLabel()
		{
			SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
			BackColor = Color.Transparent;
		}

		protected override void OnPaint(PaintEventArgs e)
		{
			e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
			using GraphicsPath path = RoundedPath(new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1)), CornerRadius);
			using SolidBrush brush = new(FillColor);
			e.Graphics.FillPath(brush, path);
			TextRenderer.DrawText(
				e.Graphics,
				Text,
				Font,
				ClientRectangle,
				TextColor,
				TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
		}
	}
}
