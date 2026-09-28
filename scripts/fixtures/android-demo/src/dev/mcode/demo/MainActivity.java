package dev.mcode.demo;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** One screen: a counter, a nickname, a dark-mode box and a save button - built in code, so no resources need compiling. */
public class MainActivity extends Activity {
  private int count = 0;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(48, 48, 48, 48);

    final TextView value = new TextView(this);
    value.setText("计数：0");
    value.setTextSize(20);
    root.addView(value);

    Button plus = new Button(this);
    plus.setText("加一");
    plus.setOnClickListener(v -> {
      count = Logic.plus(count);
      value.setText("计数：" + count);
    });
    root.addView(plus);

    Button minus = new Button(this);
    minus.setText("减一");
    minus.setOnClickListener(v -> {
      count = Logic.minus(count);
      value.setText("计数：" + count);
    });
    root.addView(minus);

    final EditText nick = new EditText(this);
    nick.setHint("昵称");
    nick.setContentDescription("昵称");
    root.addView(nick);

    final CheckBox dark = new CheckBox(this);
    dark.setText("深色模式");
    root.addView(dark);

    final TextView saved = new TextView(this);
    Button save = new Button(this);
    save.setText("保存");
    save.setOnClickListener(v -> saved.setText(Logic.savedText(nick.getText().toString(), dark.isChecked())));
    root.addView(save);
    root.addView(saved);

    setContentView(root);
  }
}
