package gui.items.imprints;

import java.awt.Component;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import javax.swing.JMenuItem;
import core.item.ItemCls;
import core.item.imprints.ImprintCls;
import core.item.persons.PersonCls;
import gui.items.Item_SplitPanel;
import gui.items.accounts.Account_Send_Dialog;
import gui.items.mails.Mail_Send_Dialog;
import lang.Lang;

public class Imprints_Favorite_SplitPanel extends Item_SplitPanel {
	private static final long serialVersionUID = 2717571093561259483L;
	private static Imprints_Favorite_TableModel table_Model = new Imprints_Favorite_TableModel();
	private Imprints_Favorite_SplitPanel th;

	public Imprints_Favorite_SplitPanel() {
		super(table_Model, "Persons_Favorite_SplitPanel");
		this.setName(Lang.getInstance().translate("Favorite Persons"));
		th = this;
		JMenuItem vsend_Coins_Item = new JMenuItem(Lang.getInstance().translate("Send Asset"));

		vsend_Coins_Item.addActionListener(new ActionListener() {
			@Override
			public void actionPerformed(ActionEvent e) {
				new Account_Send_Dialog(null, null, null, (PersonCls) th.item_Menu).show();
			}
		});

		th.menu_Table.add(vsend_Coins_Item);
		JMenuItem send_Mail_Item = new JMenuItem(Lang.getInstance().translate("Send Mail"));
		send_Mail_Item.addActionListener(new ActionListener() {
			@Override
			public void actionPerformed(ActionEvent e) {
				new Mail_Send_Dialog(null, null, null, (PersonCls) th.item_Menu);
			}
		});

		th.menu_Table.add(send_Mail_Item);
	}

	// show details
	@Override
	public Component get_show(ItemCls item) {
		return new Imprints_Info_Panel((ImprintCls) item);
	}
	
	@Override
	protected void splitClose(){ 
		table_Model.removeObservers();
		
	}
}