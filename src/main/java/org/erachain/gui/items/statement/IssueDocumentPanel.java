package org.erachain.gui.items.statement;

import org.erachain.controller.Controller;
import org.erachain.core.BlockChain;
import org.erachain.core.account.Account;
import org.erachain.core.account.PrivateKeyAccount;
import org.erachain.core.exdata.ExDataPanel;
import org.erachain.core.transaction.RSignNote;
import org.erachain.core.transaction.Transaction;
import org.erachain.gui.MainFrame;
import org.erachain.gui.PasswordPane;
import org.erachain.gui.library.IssueConfirmDialog;
import org.erachain.gui.library.MButton;
import org.erachain.gui.models.AccountsComboBoxModel;
import org.erachain.gui.transaction.OnDealClick;
import org.erachain.lang.Lang;
import org.erachain.settings.Settings;

import javax.swing.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;

/**
 * @author Саша
 */
public class IssueDocumentPanel extends javax.swing.JPanel {

    private static String iconFile = Settings.getInstance().getPatnIcons() + "IssueDocumentPanel.png";
    private IssueDocumentPanel th;
    private ExDataPanel exData_Panel;
    private MButton jButton_Work_Cancel;
    private MButton jButton_Work_OK;
    private MButton jButton_Work_OK1;
    private javax.swing.JComboBox jComboBox_Account_Work;
    private javax.swing.JLabel jLabel_Account_Work;
    private javax.swing.JLabel jLabel_Fee_Work;
    private javax.swing.JPanel jPanel_Work;
    private javax.swing.JComboBox<String> txtFeePow;
    /**
     * Creates new form IssueDocumentPanel
     */
    public IssueDocumentPanel() {

        th = this;
        initComponents();

        txtFeePow.setModel(new javax.swing.DefaultComboBoxModel<>(new String[] { "0", "1", "2", "3", "4", "5", "6", "7", "8" }));
        txtFeePow.setSelectedIndex(0);
        jLabel_Account_Work.setText(Lang.getInstance().translate("Select account") + ":");
        jButton_Work_OK.setText(Lang.getInstance().translate("Sign and Send"));
        jButton_Work_OK.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {
                onSendClick();
            }
        });
        jButton_Work_OK1.setText(Lang.getInstance().translate("Sign and Pack"));

        jLabel_Fee_Work.setText(Lang.getInstance().translate("Fee") + ":");
        this.jButton_Work_Cancel.setVisible(false);
    }

    /**
     * This method is called from within the constructor to initialize the form.
     * WARNING: Do NOT modify this code. The content of this method is always
     * regenerated by the Form Editor.
     */
    private void initComponents() {
        java.awt.GridBagConstraints gridBagConstraints;

        jPanel_Work = new javax.swing.JPanel();
        jLabel_Account_Work = new javax.swing.JLabel();
        jComboBox_Account_Work = new JComboBox<Account>(new AccountsComboBoxModel());
        jLabel_Fee_Work = new javax.swing.JLabel();
        txtFeePow = new javax.swing.JComboBox();
        jButton_Work_Cancel = new MButton();
        jButton_Work_OK = new MButton();
        jButton_Work_OK1 = new MButton();

        java.awt.GridBagLayout layout = new java.awt.GridBagLayout();
        layout.columnWidths = new int[]{0, 0, 0};
        layout.rowHeights = new int[]{0, 0, 0, 0, 0, 0, 0};
        setLayout(layout);

        exData_Panel = new ExDataPanel();
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 2;
        gridBagConstraints.gridwidth = 3;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.NORTHWEST;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.4;
        gridBagConstraints.insets = new java.awt.Insets(16, 8, 0, 8);
        add(exData_Panel, gridBagConstraints);

        jPanel_Work.setLayout(new java.awt.GridBagLayout());

        jLabel_Account_Work.setText("Account: ");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.anchor = java.awt.GridBagConstraints.LINE_END;
        gridBagConstraints.insets = new java.awt.Insets(8, 8, 8, 0);
        jPanel_Work.add(jLabel_Account_Work, gridBagConstraints);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.gridwidth = 6;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(8, 8, 8, 8);
        jPanel_Work.add(jComboBox_Account_Work, gridBagConstraints);

        jLabel_Fee_Work.setText("Fee: ");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.LINE_END;
        gridBagConstraints.insets = new java.awt.Insets(8, 8, 8, 0);
        jPanel_Work.add(jLabel_Fee_Work, gridBagConstraints);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.insets = new java.awt.Insets(8, 8, 8, 8);
        gridBagConstraints.gridwidth = 3;
        jPanel_Work.add(txtFeePow, gridBagConstraints);

        jButton_Work_Cancel.setText("Cancel");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 4;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.insets = new java.awt.Insets(8, 16, 8, 16);
        jPanel_Work.add(jButton_Work_Cancel, gridBagConstraints);

        jButton_Work_OK.setText("OK");
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 5;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.insets = new java.awt.Insets(8, 16, 8, 16);
        jPanel_Work.add(jButton_Work_OK, gridBagConstraints);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 6;
        gridBagConstraints.gridwidth = 3;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(8, 8, 8, 8);
        add(jPanel_Work, gridBagConstraints);
        jPanel_Work.getAccessibleContext().setAccessibleName("Work");
        jPanel_Work.getAccessibleContext().setAccessibleDescription("");
        this.setMinimumSize(new Dimension(0, 0));

    }// </editor-fold>

    public Integer makeDeal(int forDeal) {
        // check title
        if (exData_Panel.jTextField_Title_Message.getText() == ""
                || exData_Panel.jTextField_Title_Message.getText().length() < 5) {
            JOptionPane.showMessageDialog(null, Lang.getInstance().translate("Invalid Title"),
                    Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
            return null;

        }
        // CHECK IF WALLET UNLOCKED
        if (!Controller.getInstance().isWalletUnlocked()) {
            // ASK FOR PASSWORD
            String password = PasswordPane.showUnlockWalletDialog(this);
            if (password.equals("")) {
                return null;
            }
            if (!Controller.getInstance().unlockWallet(password)) {
                // WRONG PASSWORD
                JOptionPane.showMessageDialog(null, Lang.getInstance().translate("Invalid password"),
                        Lang.getInstance().translate("Unlock Wallet"), JOptionPane.ERROR_MESSAGE);

                return null;
            }
        }

        // READ SENDER
        Account sender = (Account) this.jComboBox_Account_Work.getSelectedItem();
        int feePow = 0;
        byte[] messageBytes;
        long key = 0;
        int parsing = 0;
        Integer result = 0;
        try {

            // READ AMOUNT
            parsing = 1;

            // READ FEE
            parsing = 2;
            feePow = Integer.parseInt((String)this.txtFeePow.getSelectedItem());
            // read byte[] from exData Panel
            messageBytes = exData_Panel.getExData();

            if (messageBytes.length < 10 || messageBytes.length > BlockChain.MAX_REC_DATA_BYTES) {
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Message size exceeded! 10...MAX"),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);

                return null;
            }

            parsing = 5;

        } catch (Exception e) {
            // CHECK WHERE PARSING ERROR HAPPENED
            switch (parsing) {
                case 1:

                    JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Invalid amount!"),
                            Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                    break;

                case 2:

                    JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Invalid fee!"),
                            Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                    break;

                case 5:

                    JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Template not exist!"),
                            Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                    break;
            }
            return null;
        }

        // CREATE TX MESSAGE
        byte version = (byte) 2;
        byte property1 = (byte) 0;
        byte property2 = (byte) 0;

        PrivateKeyAccount creator = Controller.getInstance().getWalletPrivateKeyAccountByAddress(sender.getAddress());
        if (creator == null) {
            JOptionPane.showMessageDialog(new JFrame(),
                    Lang.getInstance().translate(OnDealClick.resultMess(Transaction.PRIVATE_KEY_NOT_FOUND)),
                    Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
            return null;
        }

        RSignNote issueDoc = (RSignNote) Controller.getInstance().r_SignNote(version, property1, property2, forDeal,
                creator, feePow, key, messageBytes,
                new byte[]{1}, new byte[]{0});

        // Issue_Asset_Confirm_Dialog cont = new
        // Issue_Asset_Confirm_Dialog(issueAssetTransaction);
        String text = "<HTML><body>";
        text += Lang.getInstance().translate("Confirmation Transaction") + ":&nbsp;"
                + Lang.getInstance().translate("Issue Asset") + "<br><br><br>";
        text += Lang.getInstance().translate("Creator") + ":&nbsp;" + issueDoc.getCreator() + "<br>";
        // text += Lang.getInstance().translate("Name") +":&nbsp;"+
        // issueDoc.getItem().viewName() +"<br>";
        // text += Lang.getInstance().translate("Quantity") +":&nbsp;"+
        // ((AssetCls)issueAssetTransaction.getItem()).getQuantity().toString()+"<br>";
        // text += Lang.getInstance().translate("Movable") +":&nbsp;"+
        // Lang.getInstance().translate(((AssetCls)issueAssetTransaction.getItem()).isMovable()+"")+
        // "<br>";
        // text += Lang.getInstance().translate("Divisible") +":&nbsp;"+
        // Lang.getInstance().translate(((AssetCls)issueAssetTransaction.getItem()).isDivisible()+"")+
        // "<br>";
        // text += Lang.getInstance().translate("Scale") +":&nbsp;"+
        // ((AssetCls)issueAssetTransaction.getItem()).getScale()+ "<br>";
        // text += Lang.getInstance().translate("Description")+":<br>"+
        // Library.to_HTML(issueAssetTransaction.getItem().getDescription())+"<br>";
        String Status_text = "";

        // System.out.print("\n"+ text +"\n");
        // UIManager.put("OptionPane.cancelButtonText", "Отмена");
        // UIManager.put("OptionPane.okButtonText", "Готово");

        // int s = JOptionPane.showConfirmDialog(MainFrame.getInstance(), text,
        // Lang.getInstance().translate("Issue Asset"),
        // JOptionPane.YES_NO_OPTION);

        IssueConfirmDialog dd = new IssueConfirmDialog(MainFrame.getInstance(), true, issueDoc,
                text,
                (int) (th.getWidth() / 1.2), (int) (th.getHeight() / 1.2), Status_text,
                Lang.getInstance().translate("Confirmation transaction issue document"));

        StatementInfo ww = new StatementInfo(issueDoc);
        ww.jPanel2.setVisible(false);
        dd.jScrollPane1.setViewportView(ww);
        dd.setLocationRelativeTo(th);
        dd.setVisible(true);

        // JOptionPane.OK_OPTION
        if (dd.isConfirm) { // s!= JOptionPane.OK_OPTION) {

            // VALIDATE AND PROCESS
            result = Controller.getInstance().getTransactionCreator().afterCreate(issueDoc, forDeal);

            // CHECK VALIDATE MESSAGE
            if (result == Transaction.VALIDATE_OK) {
                return result;
            } else {
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate(OnDealClick.resultMess(result)),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                return null;
            }
        }

        return null;
    }

    public void onSendClick() {
        this.jButton_Work_OK.setEnabled(false);
        this.jButton_Work_OK1.setEnabled(false);
        Integer result = makeDeal(Transaction.FOR_NETWORK);
        if (result != null) {
            JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Statement has been sent!"),
                    Lang.getInstance().translate("Success"), JOptionPane.INFORMATION_MESSAGE);
        }
        this.jButton_Work_OK.setEnabled(true);
        this.jButton_Work_OK1.setEnabled(true);
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
