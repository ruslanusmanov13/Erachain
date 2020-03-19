package org.erachain.gui.items.accounts;

import org.erachain.controller.Controller;
import org.erachain.core.account.Account;
import org.erachain.core.item.assets.AssetCls;
import org.erachain.core.item.persons.PersonCls;
import org.erachain.core.transaction.RSend;
import org.erachain.core.transaction.Transaction;
import org.erachain.core.transaction.TransactionAmount;
import org.erachain.gui.library.IssueConfirmDialog;
import org.erachain.gui.transaction.Send_RecordDetailsFrame;
import org.erachain.lang.Lang;
import org.erachain.settings.Settings;

import java.awt.*;

//import org.erachain.settings.Settings;

@SuppressWarnings("serial")

public class AccountAssetLendPanel extends AccountAssetActionPanelCls  {

    private static String iconFile = Settings.getInstance().getPatnIcons()+ "AccountAssetLendPanel.png";
    public AccountAssetLendPanel(AssetCls assetIn, Account accountFrom, Account accountTo, PersonCls person) {
        // "If You want to give a loan asset %asset%, fill in this form"
        super(false, null, assetIn,
                null, TransactionAmount.ACTION_DEBT, accountFrom, accountTo, null);

        //	icon.setIcon(null);

    }

    @Override
    public void onSendClick() {
        // confirm params
        if (!cheskError()) return;

        //CREATE TX MESSAGE
        Transaction transaction = Controller.getInstance()
                .r_Send(Controller.getInstance().getPrivateKeyAccountByAddress(sender.getAddress()), feePow, recipient,
                        -key, amount,
                        head, messageBytes, isTextByte, encrypted, 0);

        String Status_text = "";
        IssueConfirmDialog dd = new IssueConfirmDialog(null, true, transaction,
                Lang.getInstance().translate("Lend"), (int) (this.getWidth() / 1.2), (int) (this.getHeight() / 1.2),
                Status_text, Lang.getInstance().translate("Confirmation Transaction"));

        Send_RecordDetailsFrame ww = new Send_RecordDetailsFrame((RSend) transaction);

        dd.jScrollPane1.setViewportView(ww);
        dd.pack();
        dd.setLocationRelativeTo(this);
        dd.setVisible(true);

        //	JOptionPane.OK_OPTION
        if (dd.isConfirm) {


            result = Controller.getInstance().getTransactionCreator().afterCreate(transaction, Transaction.FOR_NETWORK);

            confirmaftecreatetransaction();
        }

        //ENABLE
        this.jButton_ok.setEnabled(true);
    }

    public static Image getIcon() {
        {
            try {
                return Toolkit.getDefaultToolkit().getImage(iconFile);
            } catch (Exception e) {
                return null;
            }
        }
    }
}


