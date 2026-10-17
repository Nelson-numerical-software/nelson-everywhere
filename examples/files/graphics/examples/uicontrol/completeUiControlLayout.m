function completeUiControlLayout(figureHandle, event)
  if ~isgraphics(figureHandle)
    return;
  end
  state = figureHandle.UserData;
  if ~isstruct(state) || ~isfield(state, 'axes')
    return;
  end
  position = figureHandle.Position;
  width = max(1, position(3));
  if ~isempty(event) && isfield(struct(event), 'Width')
    width = max(1, event.Width);
  end
  left = max(330, width * 0.38);
  plotWidth = max(1, width - left - width * 0.05);
  state.axes.Position = [left / width 0.22 plotWidth / width 0.70];
  state.statusText.Position = [left - 5 35 max(1, width - left - 45) 32];
end
